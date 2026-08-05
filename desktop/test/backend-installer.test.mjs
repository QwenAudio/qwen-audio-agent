import assert from 'node:assert/strict'
import test from 'node:test'
import { createBackendInstaller } from '../src/backend-installer.mjs'

test('delegates support queries to the shared install specs', () => {
  const installer = createBackendInstaller({ env: {}, platform: 'darwin' })
  assert.equal(installer.support('opencode').supported, true)
  assert.equal(installer.support('acp').supported, false)
  assert.equal(
    installer.support('hermes').requiresConfirmation,
    true,
  )
  const win32 = createBackendInstaller({ env: {}, platform: 'win32' })
  assert.equal(win32.support('hermes').supported, false)
})

test('wires progress, inspection and script confirmation through', async () => {
  const seen = {}
  const installer = createBackendInstaller({
    env: { MARKER: '1' },
    platform: 'darwin',
    confirmScript: async step => {
      seen.confirm = step
      return true
    },
    install: async (id, options) => {
      seen.id = id
      seen.env = options.env
      seen.platform = options.platform
      options.onProgress({ phase: 'start' })
      seen.confirmed = await options.confirmStep({ command: 'curl …' })
      seen.hasInspect = typeof options.inspect === 'function'
      return { ok: true }
    },
  })
  const progress = []
  const result = await installer.install('hermes', {
    onProgress: event => progress.push(event),
    inspect: async () => ({}),
  })
  assert.equal(result.ok, true)
  assert.equal(seen.id, 'hermes')
  assert.deepEqual(seen.env, { MARKER: '1' })
  assert.equal(seen.platform, 'darwin')
  assert.equal(seen.confirmed, true)
  assert.deepEqual(seen.confirm, { command: 'curl …' })
  assert.equal(seen.hasInspect, true)
  assert.deepEqual(progress, [{ phase: 'start' }])
})

test('reads the latest settings environment for support and install', async () => {
  let marker = 'before'
  const seen = []
  const installer = createBackendInstaller({
    env: () => ({ MARKER: marker }),
    platform: 'darwin',
    install: async (_id, options) => {
      seen.push(options.env.MARKER)
      return { ok: true }
    },
  })

  await installer.install('opencode')
  marker = 'after'
  await installer.install('opencode')

  assert.deepEqual(seen, ['before', 'after'])
})

test('rejects concurrent installs of the same backend', async () => {
  const resolvers = []
  const installer = createBackendInstaller({
    install: () => new Promise(resolve => resolvers.push(resolve)),
  })
  const finish = () => {
    while (resolvers.length) resolvers.shift()({ ok: true })
  }
  const first = installer.install('codex')
  await assert.rejects(installer.install('codex'), /正在安装中/)
  // 不同后台不受同一守卫限制。
  const other = installer.install('claude')
  finish()
  assert.deepEqual(await first, { ok: true })
  assert.deepEqual(await other, { ok: true })
  // 完成后守卫释放，可以再次安装。
  const again = installer.install('codex')
  finish()
  assert.deepEqual(await again, { ok: true })
})

test('propagates installer failures without swallowing them', async () => {
  const installer = createBackendInstaller({
    install: async () => ({
      ok: false,
      error: { code: 'DECLINED', message: '已取消安装' },
    }),
  })
  const result = await installer.install('hermes')
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'DECLINED')
})
