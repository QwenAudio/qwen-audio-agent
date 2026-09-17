import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import { resolveRuntimePaths, runtimePathEnvironment } from '../shared/runtime-paths.mjs'
import { loadRuntimeEnvironment } from '../shared/runtime-environment.mjs'
import { defaultLogDirectory } from '../shared/logger.mjs'
import { pathCacheFile } from '../shared/process-path.mjs'
import { gatewayOptionsEnvironment } from '../shared/gateway/options.mjs'
import { tuiClientDirectory } from '../shared/client-paths.mjs'

function fixture(t) {
  const root = mkdtempSync(resolve(tmpdir(), 'qwaudio-paths-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

test('default layout separates user assets, state and disposable cache', () => {
  const config = resolve('/user/.config/qwaudio')
  assert.deepEqual(resolveRuntimePaths({ env: {}, homeDirectory: '/user' }), {
    configDirectory: config,
    dataDirectory: resolve(config, 'data'),
    stateDirectory: resolve(config, 'state'),
    cacheDirectory: resolve(config, 'cache'),
    sharedWorkspace: resolve(config, 'data/workspace'),
  })
  const custom = resolveRuntimePaths({ env: { XDG_CONFIG_HOME: '/custom' } })
  assert.equal(custom.configDirectory, resolve('/custom/qwaudio'))
})

test('desktop changes only state, not configuration, identity, memory or workspace', t => {
  const root = fixture(t)
  const options = { root, env: { QWAUDIO_CONFIG_DIR: resolve(root, 'profile') } }
  const cli = loadRuntimeEnvironment(options)
  const desktop = loadRuntimeEnvironment({
    root, env: { QWAUDIO_CONFIG_DIR: cli.configDirectory }, defaultStateDirectory: 'state/desktop',
  })
  for (const key of ['configPath', 'assistantProfilePath', 'identityPath', 'userModelPath',
    'frontendMemoryPath', 'frontendNotesPath', 'sharedWorkspace', 'cacheDirectory']) {
    assert.equal(desktop[key], cli[key], key)
  }
  assert.notEqual(desktop.taskStatePath, cli.taskStatePath)
  assert.equal(desktop.stateDirectory, resolve(cli.configDirectory, 'state/desktop'))
  assert.notEqual(desktop.openClawStateDirectory, cli.openClawStateDirectory)
})

test('TUI state follows the product root but ignores Gateway data, state and cache overrides', () => {
  const env = { QWAUDIO_CONFIG_DIR: '/gateway', QWAUDIO_DATA_DIR: '/data',
    QWAUDIO_STATE_DIR: '/state', QWAUDIO_CACHE_DIR: '/cache' }
  assert.equal(tuiClientDirectory({}, '/user'), resolve('/user/.config/qwaudio/tui'))
  assert.equal(tuiClientDirectory({ XDG_CONFIG_HOME: '/xdg' }), resolve('/xdg/qwaudio/tui'))
  assert.equal(tuiClientDirectory(env, '/user'), resolve('/gateway/tui'))
  assert.equal(tuiClientDirectory({ ...env, XDG_CONFIG_HOME: '/xdg' }), resolve('/gateway/tui'))
  assert.equal(tuiClientDirectory({ ...env, QWAUDIO_TUI_DIR: '/client' }), resolve('/client'))
})

test('config.env directory overrides are resolved before forwarding to children', t => {
  const root = fixture(t)
  const configDir = resolve(root, 'config')
  mkdirSync(configDir)
  writeFileSync(resolve(configDir, 'config.env'), [
    'QWAUDIO_DATA_DIR=assets', 'QWAUDIO_STATE_DIR=instance',
    'QWAUDIO_CACHE_DIR=cache', 'QWAUDIO_WORKSPACE=projects',
  ].join('\n'))
  const env = { QWAUDIO_CONFIG_DIR: configDir }
  const paths = loadRuntimeEnvironment({ root, env, readOnly: true })
  assert.equal(paths.dataDirectory, resolve(root, 'assets'))
  assert.equal(paths.stateDirectory, resolve(root, 'instance'))
  assert.equal(paths.sharedWorkspace, resolve(root, 'projects'))
  assert.equal(paths.cacheDirectory, resolve(root, 'cache'))
  assert.equal(paths.configPath, resolve(configDir, 'config.env'))
  assert.equal(existsSync(paths.dataDirectory), false)
  const child = resolveRuntimePaths({ env: runtimePathEnvironment(paths), baseDirectory: '/different' })
  assert.deepEqual(child, resolveRuntimePaths({ env, baseDirectory: root }))
})

test('all backend defaults follow the shared workspace, with explicit backend overrides', t => {
  const root = fixture(t)
  const paths = loadRuntimeEnvironment({ root, env: {
    QWAUDIO_CONFIG_DIR: resolve(root, 'profile'),
    QWAUDIO_WORKSPACE: resolve(root, 'projects'),
    QODER_WORKSPACE: resolve(root, 'qoder-project'),
  } })
  assert.equal(paths.openCodeWorkspace, paths.sharedWorkspace)
  assert.equal(paths.openClawWorkspace, paths.sharedWorkspace)
  assert.equal(paths.codexWorkspace, paths.sharedWorkspace)
  assert.equal(paths.qoderWorkspace, resolve(root, 'qoder-project'))
})

test('logs and PATH cache follow their own directory overrides', () => {
  const env = { QWAUDIO_CONFIG_DIR: '/config', QWAUDIO_STATE_DIR: '/state', QWAUDIO_CACHE_DIR: '/cache' }
  assert.equal(defaultLogDirectory(env), resolve('/state/logs'))
  assert.equal(pathCacheFile(env), resolve('/cache/login-shell-path.json'))
  assert.equal(defaultLogDirectory({ ...env, QWEN_AUDIO_LOG_DIR: '/logs' }), resolve('/logs'))
})

test('a host state default never overrides explicit configuration', t => {
  const root = fixture(t)
  const configDir = resolve(root, 'config')
  mkdirSync(configDir)
  writeFileSync(resolve(configDir, 'config.env'), 'QWAUDIO_STATE_DIR=chosen-state\n')
  const paths = loadRuntimeEnvironment({ root, env: { QWAUDIO_CONFIG_DIR: configDir },
    defaultStateDirectory: resolve(root, 'desktop-state'), readOnly: true })
  assert.equal(paths.stateDirectory, resolve(root, 'chosen-state'))
  assert.equal(resolveRuntimePaths({ env: {}, defaultStateDirectory: resolve(root, 'desktop') }).stateDirectory,
    resolve(root, 'desktop'))
})

test('default directories do not leak between embedded profiles through the environment', t => {
  const root = fixture(t)
  const env = { QWAUDIO_CONFIG_DIR: resolve(root, 'first') }
  loadRuntimeEnvironment({ root, env, readOnly: true })
  assert.equal(env.QWAUDIO_DATA_DIR, undefined)
  assert.equal(env.QWAUDIO_STATE_DIR, undefined)
  env.QWAUDIO_CONFIG_DIR = resolve(root, 'second')
  const next = loadRuntimeEnvironment({ root, env, readOnly: true })
  assert.equal(next.dataDirectory, resolve(root, 'second/data'))
  assert.equal(next.stateDirectory, resolve(root, 'second/state'))
})

test('startup neither reads nor migrates old memory and task locations', t => {
  const root = fixture(t)
  const configDir = resolve(root, 'config')
  mkdirSync(configDir)
  writeFileSync(resolve(configDir, 'MEMORY.md'), 'legacy memory')
  writeFileSync(resolve(configDir, 'tasks.json'), 'legacy tasks')
  const paths = loadRuntimeEnvironment({ root, env: { QWAUDIO_CONFIG_DIR: configDir } })
  assert.doesNotMatch(readFileSync(paths.frontendMemoryPath, 'utf8'), /legacy memory/)
  assert.equal(readFileSync(resolve(configDir, 'MEMORY.md'), 'utf8'), 'legacy memory')
  assert.equal(readFileSync(resolve(configDir, 'tasks.json'), 'utf8'), 'legacy tasks')
  assert.equal(existsSync(paths.taskStatePath), false)
})

test('embedding hosts can specify directories without backend-specific settings', () => {
  assert.deepEqual(gatewayOptionsEnvironment({ configDir: '/config', dataDir: '/data',
    stateDir: '/state', cacheDir: '/cache', workspace: '/projects' }), {
    QWAUDIO_CONFIG_DIR: '/config', QWAUDIO_DATA_DIR: '/data', QWAUDIO_STATE_DIR: '/state',
    QWAUDIO_CACHE_DIR: '/cache', QWAUDIO_WORKSPACE: '/projects',
  })
})
