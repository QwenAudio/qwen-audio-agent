import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { backendRuntimeDirectory, inspectBackendRuntimePackage } from '../../shared/backend/runtime-package.mjs'
import { installBackend, installSupport } from '../../shared/backend/install.mjs'
import { inspectBackendSetups } from '../../shared/backend/setup.mjs'
import { backendEnvironment } from '../../shared/backend/environment.mjs'
import { loadMuseSdk, MuseBackendAdapter } from '../src/backend/adapters/muse/backend-adapter.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'muse-runtime-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const env = { QWAUDIO_DATA_DIR: join(root, 'data with spaces') }
  const directory = backendRuntimeDirectory('muse', env)
  const pkg = join(directory, 'node_modules', '@muse-code', 'sdk')
  const install = (version = '0.1.1', source = 'export const marker = "loaded"') => {
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({
      name: '@muse-code/sdk', version, type: 'module', main: 'index.mjs',
    }))
    writeFileSync(join(pkg, 'index.mjs'), source)
  }
  return { env, directory, install }
}

test('framework manifests and lockfile do not install the optional Muse SDK', () => {
  for (const file of ['../../package.json', '../package.json']) {
    const manifest = JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8'))
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      assert.equal(manifest[section]?.['@muse-code/sdk'], undefined)
    }
  }
  const lock = readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8')
  assert.equal(lock.includes('@muse-code/sdk'), false)
})

test('SDK missing or wrong version is actionable; detection never evaluates package code', async t => {
  const { env, directory, install } = fixture(t)
  assert.equal(inspectBackendRuntimePackage('muse', { env }).ready, false)
  await assert.rejects(loadMuseSdk(directory), { code: 'MUSE_SDK_NOT_INSTALLED' })
  install('9.9.9')
  await assert.rejects(loadMuseSdk(directory), /qwenaudio install muse/)
  install('0.1.1', 'throw new Error("SDK was evaluated")')
  assert.equal(inspectBackendRuntimePackage('muse', { env }).ready, true)
  const report = inspectBackendSetups({ backend: 'muse', env, find: () => '/installed/muse' })
  assert.equal(report.backends[0].ready, true)
  await assert.rejects(loadMuseSdk(directory), /SDK was evaluated/)
})

test('SDK loads from the private runtime only when explicitly requested', async t => {
  const { env, directory, install } = fixture(t)
  install()
  const backend = new MuseBackendAdapter({ env })
  assert.equal(backend.sdkDirectory, directory)
  assert.equal(backend.client, null)
  assert.equal((await loadMuseSdk(directory)).marker, 'loaded')
  await backend.close()
})

test('setup reports a missing SDK even when Muse executable is installed', t => {
  const { env } = fixture(t)
  const report = inspectBackendSetups({ backend: 'muse', env, find: () => '/installed/muse' })
  const item = report.backends[0]
  assert.equal(item.backend.ready, true)
  assert.equal(item.adapter.ready, false)
  assert.equal(item.ready, false)
  assert.match(item.issues.join(' '), /qwenaudio install muse/)
})

test('explicit install adds only a missing private SDK and skips an existing Muse host', async t => {
  const { env, directory, install } = fixture(t)
  const calls = []
  const inspect = options => inspectBackendSetups({ ...options, find: () => '/installed/muse' })
  const result = await installBackend('muse', {
    env, platform: 'darwin', inspect, find: () => '/node/npm',
    confirmStep: async () => { throw new Error('Must not reinstall the host') },
    spawnImpl(command, args) {
      calls.push({ command, args })
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      process.nextTick(() => { install(); child.emit('close', 0) })
      return child
    },
    inspectAuthentication: async () => ({ status: 'unknown' }),
  })
  assert.equal(result.ok, true)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].args, [
    'install', '--prefix', directory, '--no-save', '--package-lock=false',
    '--ignore-scripts', '--no-audit', '--no-fund', '@muse-code/sdk@0.1.1',
  ])
  const again = await installBackend('muse', {
    env, platform: 'darwin', inspect,
    spawnImpl() { throw new Error('Must not reinstall a ready SDK') },
    inspectAuthentication: async () => ({ status: 'unknown' }),
  })
  assert.equal(again.alreadyInstalled, true)
})

test('Windows/WSL install offers the host-side SDK without a Unix install script', t => {
  const { env, directory } = fixture(t)
  const support = installSupport('muse', { env, platform: 'win32' })
  assert.equal(support.requiresConfirmation, false)
  assert.equal(support.steps.length, 1)
  assert.ok(support.steps[0].display.includes(JSON.stringify(directory)))
  assert.match(support.steps[0].display, /--ignore-scripts/)
  assert.equal(resolve(directory).startsWith(resolve(env.QWAUDIO_DATA_DIR)), true)
})

test('Muse receives its own API credential but not other providers credentials', () => {
  const env = backendEnvironment('muse', { env: {
    META_API_KEY: 'muse-test-key', DASHSCOPE_API_KEY: 'other-test-key',
    OPENAI_API_KEY: 'other-test-key', QWAUDIO_DATA_DIR: '/private/gateway',
  } })
  assert.equal(env.META_API_KEY, 'muse-test-key')
  assert.equal(env.DASHSCOPE_API_KEY, undefined)
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.equal(env.QWAUDIO_DATA_DIR, undefined)
})
