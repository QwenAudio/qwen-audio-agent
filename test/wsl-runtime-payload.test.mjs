import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  buildWslRuntimePayload,
  validatePackEntry,
} from '../scripts/build-wsl-runtime-payload.mjs'

const VERSION = '1.2.0'
const TARBALL = `qwen-audio-agent-${VERSION}.tgz`
const PAYLOAD = Buffer.from('deterministic test payload\n')

async function createFixture({
  packageVersion = VERSION,
  desktopVersion = VERSION,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'qwaudio-wsl-payload-'))
  await mkdir(join(root, 'desktop'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'qwen-audio-agent',
    version: packageVersion,
  }))
  await writeFile(join(root, 'desktop/package.json'), JSON.stringify({
    name: '@qwen-audio-agent/desktop',
    version: desktopVersion,
  }))
  return root
}

function packResult({
  name = 'qwen-audio-agent',
  version = VERSION,
  filename = TARBALL,
  payload = PAYLOAD,
  calls = [],
} = {}) {
  return (command, args, options) => {
    calls.push({ command, args, options })
    const destinationIndex = args.indexOf('--pack-destination')
    assert.notEqual(destinationIndex, -1)
    const destination = args[destinationIndex + 1]
    if (!filename.includes('/') && !filename.includes('\\')) {
      writeFileSync(join(destination, filename), payload)
    }
    return {
      status: 0,
      stdout: JSON.stringify([{
        id: `${name}@${version}`,
        name,
        version,
        filename,
        files: [],
      }]),
      stderr: '',
    }
  }
}

test('publishes a deterministic two-file payload with a SHA-256 manifest', async t => {
  const root = await createFixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const calls = []

  const result = await buildWslRuntimePayload({
    rootDirectory: root,
    spawnImpl: packResult({ calls }),
    npmCommand: 'npm',
    protocolVersion: 1,
  })

  const outputDirectory = join(root, 'dist/wsl-runtime')
  assert.deepEqual((await readdir(outputDirectory)).sort(), ['manifest.json', TARBALL])
  assert.equal(result.tarballPath, join(outputDirectory, TARBALL))
  assert.deepEqual(
    JSON.parse(await readFile(join(outputDirectory, 'manifest.json'), 'utf8')),
    {
      schemaVersion: 1,
      packageName: 'qwen-audio-agent',
      packageVersion: VERSION,
      desktopVersion: VERSION,
      protocolVersion: 1,
      sha256: createHash('sha256').update(PAYLOAD).digest('hex'),
      tarball: TARBALL,
    },
  )
  assert.deepEqual(calls[0].args.slice(0, 2), ['pack', '--json'])
  assert.equal(calls[0].options.cwd, root)
})

test('cleans stale payload files without touching sibling release output', async t => {
  const root = await createFixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'dist/wsl-runtime'), { recursive: true })
  await mkdir(join(root, 'dist/desktop'), { recursive: true })
  await writeFile(join(root, 'dist/wsl-runtime/stale.txt'), 'stale')
  await writeFile(join(root, 'dist/desktop/keep.txt'), 'keep')

  await buildWslRuntimePayload({
    rootDirectory: root,
    spawnImpl: packResult(),
    npmCommand: 'npm',
    protocolVersion: 1,
  })

  assert.deepEqual(
    (await readdir(join(root, 'dist/wsl-runtime'))).sort(),
    ['manifest.json', TARBALL],
  )
  assert.equal(await readFile(join(root, 'dist/desktop/keep.txt'), 'utf8'), 'keep')
})

test('rejects a package or filename that does not match the repository payload', () => {
  assert.throws(() => validatePackEntry({
    name: '@scope/other',
    version: VERSION,
    filename: TARBALL,
  }, {
    packageName: 'qwen-audio-agent',
    packageVersion: VERSION,
  }), /package name/i)
  assert.throws(() => validatePackEntry({
    name: 'qwen-audio-agent',
    version: VERSION,
    filename: `../${TARBALL}`,
  }, {
    packageName: 'qwen-audio-agent',
    packageVersion: VERSION,
  }), /filename/i)
})

test('does not replace a previous payload when npm reports invalid metadata', async t => {
  const root = await createFixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'dist/wsl-runtime'), { recursive: true })
  await writeFile(join(root, 'dist/wsl-runtime/previous.txt'), 'previous')

  await assert.rejects(buildWslRuntimePayload({
    rootDirectory: root,
    spawnImpl: packResult({ name: 'unexpected-package' }),
    npmCommand: 'npm',
    protocolVersion: 1,
  }), /package name/i)

  assert.deepEqual(await readdir(join(root, 'dist/wsl-runtime')), ['previous.txt'])
})

test('fails before npm pack when the desktop and payload versions differ', async t => {
  const root = await createFixture({ desktopVersion: '1.2.1' })
  t.after(() => rm(root, { recursive: true, force: true }))
  let spawned = false

  await assert.rejects(buildWslRuntimePayload({
    rootDirectory: root,
    spawnImpl() {
      spawned = true
    },
    npmCommand: 'npm',
    protocolVersion: 1,
  }), /desktop version/i)
  assert.equal(spawned, false)
})
