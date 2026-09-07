import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createDesktopBackendManagement,
  desktopBackendEnvironment,
} from '../src/backend/management.mjs'

test('builds backend environment from non-empty config values', () => {
  const result = desktopBackendEnvironment({
    configPath: '/config.env',
    env: { PATH: '/usr/bin', KEEP: 'process' },
    exists: () => true,
    readFile: () => 'KEEP=configured\nEMPTY=\nAGENT_PROTOCOL=opencode\n',
  })
  assert.equal(result.KEEP, 'configured')
  assert.equal(result.EMPTY, undefined)
  assert.equal(result.AGENT_PROTOCOL, 'opencode')
  assert.equal(result.QWEN_AUDIO_AGENT_DESKTOP_INSTALLED_ONLY, '1')
})

test('normalizes the Windows Path environment key', () => {
  const result = desktopBackendEnvironment({
    env: { Path: 'C:\\Program Files\\nodejs' },
  })
  assert.equal(result.PATH, 'C:\\Program Files\\nodejs')
  assert.equal(result.Path, undefined)
})

test('caches and coalesces backend detection', async () => {
  let detections = 0
  let clock = 100
  let release
  const pending = new Promise(resolve => { release = resolve })
  const management = createDesktopBackendManagement({
    env: { PATH: '/usr/bin' },
    now: () => clock,
    reportTtlMs: 50,
    detect: async () => {
      detections += 1
      await pending
      return { report: [{ id: 'opencode' }], path: '/agent/bin' }
    },
    enrichReport: async report => report,
    createInstaller: () => ({ support: () => ({ supported: false }) }),
  })

  const first = management.detectBackends()
  const second = management.detectBackends()
  assert.equal(detections, 1)
  release()
  assert.deepEqual(await first, [{ id: 'opencode' }])
  assert.deepEqual(await second, [{ id: 'opencode' }])
  assert.deepEqual(await management.detectBackends(), [{ id: 'opencode' }])
  assert.equal(detections, 1)

  clock = 151
  await management.detectBackends()
  assert.equal(detections, 2)
})

test('owns backend installation progress, refresh and configuration', async () => {
  const progress = []
  const configured = []
  let inspections = 0
  const management = createDesktopBackendManagement({
    env: {},
    detect: async () => {
      inspections += 1
      return { report: [{ id: 'opencode', available: true }] }
    },
    enrichReport: async report => report,
    createInstaller: () => ({
      support: () => ({ supported: true }),
      install: async (id, options) => {
        options.onProgress({ phase: 'installing' })
        const report = await options.inspect()
        return { ok: true, id, report }
      },
    }),
    openConfiguration: async id => ({ ok: true, action: { kind: id } }),
    onInstallProgress: event => progress.push(event),
    onConfigured: event => configured.push(event),
  })

  const installed = await management.install('opencode')
  assert.equal(installed.ok, true)
  assert.equal(inspections, 1)
  assert.deepEqual(progress, [{ backend: 'opencode', phase: 'installing' }])

  const result = await management.configure({ backend: 'opencode' })
  assert.equal(result.action.kind, 'opencode')
  assert.equal(configured[0].backend, 'opencode')
})
