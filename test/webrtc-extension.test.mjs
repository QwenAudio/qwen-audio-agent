import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { requireWebRtcDependencies } from '../shared/gateway/webrtc.mjs'
import { parsePackOutput } from '../scripts/verify-package.mjs'

const source = new URL('../packages/webrtc/', import.meta.url)
const extensionName = 'qwen-audio-agent-webrtc'
const missing = () => { throw Object.assign(new Error('not installed'), { code: 'MODULE_NOT_FOUND' }) }

async function temporary(t) {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'qwaudio-webrtc-extension-')))
  t.after(() => rm(path, { recursive: true, force: true }))
  return path
}

async function extensionFixture(path, overrides = {}) {
  await mkdir(path, { recursive: true })
  const manifest = { ...JSON.parse(await readFile(new URL('package.json', source), 'utf8')), ...overrides }
  await writeFile(join(path, 'package.json'), JSON.stringify(manifest))
  for (const file of ['index.cjs', 'README.md', 'LICENSE']) await copyFile(new URL(file, source), join(path, file))
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    const directory = join(path, 'node_modules', name)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version, main: 'index.cjs' }))
    await writeFile(join(directory, 'index.cjs'), "throw new Error('native addon executed')\n")
  }
  return join(path, 'package.json')
}

function npm(args, cwd, cache) {
  const executable = process.env.npm_execpath
  const result = spawnSync(executable ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm', [
    ...(executable ? [executable] : []), ...args,
  ], {
    cwd, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, npm_config_cache: cache, npm_config_global: 'false', npm_config_update_notifier: 'false' },
    shell: !executable && process.platform === 'win32',
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  return result.stdout
}

test('installed extension preflight resolves dependencies without executing the entry point or addons', async t => {
  const path = await temporary(t)
  const manifest = await extensionFixture(path)
  const result = requireWebRtcDependencies({ resolvePackage: () => manifest, sourceManifest: null })
  assert.equal(result.apiVersion, 1)
  assert.equal(result.entryPath, join(path, 'index.cjs'))
  const require = createRequire(result.entryPath)
  const extension = require(result.entryPath)
  assert.equal(extension.apiVersion, 1)
  assert.throws(() => extension.loadNative(), /native addon executed/)
  await writeFile(join(path, 'index.cjs'), "throw new Error('extension entry executed')\n")
  assert.equal(requireWebRtcDependencies({ resolvePackage: () => manifest, sourceManifest: null }).entryPath, result.entryPath)
})

test('source checkout uses its separate package when no installed extension exists', async t => {
  const path = await temporary(t)
  const sourceManifest = await extensionFixture(path)
  assert.equal(requireWebRtcDependencies({ resolvePackage: missing, sourceManifest }).entryPath, join(path, 'index.cjs'))
})

test('absent extensions produce actionable release and source install instructions', () => {
  assert.throws(() => requireWebRtcDependencies({ resolvePackage: missing, sourceManifest: null }), error => {
    assert.equal(error.code, 'webrtc_dependencies_missing')
    assert.match(error.message, /npm install -g qwen-audio-agent-webrtc/)
    assert.match(error.message, /npm run example:webrtc:install/)
    return true
  })
})

test('incompatible installed extensions do not silently fall back to a source copy', async t => {
  const root = await temporary(t)
  const installed = await extensionFixture(join(root, 'installed'), { qwaudioWebrtcApiVersion: 2 })
  const sourceManifest = await extensionFixture(join(root, 'source'))
  assert.throws(() => requireWebRtcDependencies({ resolvePackage: () => installed, sourceManifest }), { code: 'webrtc_extension_incompatible' })
})

test('invalid package metadata and blocked exports are not treated as a missing extension', async t => {
  const path = await temporary(t)
  const manifest = join(path, 'package.json')
  await writeFile(manifest, '{broken')
  assert.throws(() => requireWebRtcDependencies({ resolvePackage: () => manifest, sourceManifest: null }), { code: 'webrtc_extension_invalid' })
  assert.throws(() => requireWebRtcDependencies({
    resolvePackage: () => { throw Object.assign(new Error('blocked export'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' }) },
    sourceManifest: manifest,
  }), { code: 'webrtc_extension_invalid' })
})

test('an incomplete extension install fails before any native module is loaded', async t => {
  const path = await temporary(t)
  const manifestPath = await extensionFixture(path)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.dependencies['qwaudio-webrtc-deliberately-missing-fixture'] = '0.0.0'
  await writeFile(manifestPath, JSON.stringify(manifest))
  assert.throws(() => requireWebRtcDependencies({ resolvePackage: () => manifestPath, sourceManifest: null }), { code: 'webrtc_dependencies_missing' })
})

test('extension tarball is independently publishable without native binaries or private files', { timeout: 40000 }, async t => {
  const path = await temporary(t)
  const manifestPath = await extensionFixture(path)
  await writeFile(join(path, '.env'), 'PRIVATE=must-not-ship')
  await writeFile(join(path, 'install.log'), 'must-not-ship')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  assert.equal(manifest.dependencies['qwen-audio-agent'], undefined)
  assert.equal(manifest.peerDependencies, undefined)
  const lock = JSON.parse(await readFile(new URL('package-lock.json', source), 'utf8'))
  assert.equal(lock.name, extensionName)
  assert.equal(lock.packages[''].name, extensionName)
  assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies)
  for (const [name, dependency] of Object.entries(lock.packages)) {
    if (dependency.resolved) assert.equal(new URL(dependency.resolved).origin, 'https://registry.npmjs.org', `${name} must use the public registry`)
  }
  const [packed] = parsePackOutput(npm(['pack', '--dry-run', '--json', '--ignore-scripts'], path, join(path, 'cache')))
  assert.deepEqual(packed.files.map(file => file.path).sort(), ['LICENSE', 'README.md', 'index.cjs', 'package.json'])
})

test('npm global installs discover the sibling extension outside the current directory', { timeout: 90000 }, async t => {
  const path = await temporary(t)
  const core = join(path, 'framework')
  await mkdir(join(core, 'shared/gateway'), { recursive: true })
  await copyFile(new URL('../shared/gateway/webrtc.mjs', import.meta.url), join(core, 'shared/gateway/webrtc.mjs'))
  await writeFile(join(core, 'package.json'), JSON.stringify({
    name: 'qwen-audio-agent', version: '1.11.0', type: 'module', files: ['shared/'],
  }))
  const extension = join(path, 'extension')
  // Only this installation fixture bundles inert native stubs, allowing a real
  // offline npm global install without executing or downloading native code.
  await extensionFixture(extension, { bundleDependencies: ['@roamhq/wrtc', 'sharp'] })
  const pack = directory => parsePackOutput(npm([
    'pack', '--json', '--ignore-scripts', '--pack-destination', path,
  ], directory, join(path, 'cache')))[0].filename
  const coreTarball = join(path, pack(core))
  const extensionTarball = join(path, pack(extension))
  const prefix = join(path, 'global')
  npm(['install', '--global', '--prefix', prefix, '--ignore-scripts', '--offline', '--no-audit', '--no-fund', coreTarball, extensionTarball], path, join(path, 'cache'))
  const modules = process.platform === 'win32' ? join(prefix, 'node_modules') : join(prefix, 'lib/node_modules')
  const loader = pathToFileURL(join(modules, 'qwen-audio-agent/shared/gateway/webrtc.mjs')).href
  const expected = join(modules, extensionName, 'index.cjs')
  const unrelated = join(path, 'unrelated')
  await mkdir(unrelated)
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict'
    import { createRequire } from 'node:module'
    import { requireWebRtcDependencies } from ${JSON.stringify(loader)}
    const resolved = requireWebRtcDependencies()
    assert.equal(resolved.entryPath, ${JSON.stringify(expected)})
    assert.equal(resolved.apiVersion, 1)
    const extension = createRequire(resolved.entryPath)(resolved.entryPath)
    assert.equal(extension.apiVersion, 1)
    assert.throws(() => extension.loadNative(), /native addon executed/)
  `], {
    cwd: unrelated, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' },
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
})
