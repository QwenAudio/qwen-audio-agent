import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import * as lifecycleModule from '../src/native-input-lifecycle.mjs'

const { NativeInputLifecycle } = lifecycleModule

class FakeHost extends EventEmitter {
  constructor() {
    super()
    this.requests = []
  }

  request(message) {
    this.requests.push(message)
    return Promise.resolve({
      type: 'lifecycle.result',
      requestId: message.requestId,
      action: message.type.slice('lifecycle.'.length),
      installed: message.type !== 'lifecycle.uninstall',
      registered: message.type !== 'lifecycle.uninstall',
      enabled: false,
      version: message.type === 'lifecycle.uninstall' ? '' : '1.11.0',
    })
  }
}

test('lifecycle exposes correlated status/install/repair/uninstall operations', async () => {
  const host = new FakeHost()
  const lifecycle = new NativeInputLifecycle({ host })

  assert.deepEqual(await lifecycle.status(), {
    installed: true,
    registered: true,
    enabled: false,
    version: '1.11.0',
    state: 'needs-enable',
  })
  assert.equal((await lifecycle.install()).state, 'needs-enable')
  assert.equal((await lifecycle.repair()).state, 'needs-enable')
  assert.equal((await lifecycle.uninstall()).state, 'not-installed')
  assert.deepEqual(host.requests.map(message => message.type), [
    'lifecycle.status',
    'lifecycle.install',
    'lifecycle.repair',
    'lifecycle.uninstall',
  ])
  assert.equal(new Set(host.requests.map(message => message.requestId)).size, 4)
})

test('lifecycle fails closed on malformed or mismatched Bridge results', async () => {
  const host = {
    request: async message => ({
      type: 'lifecycle.result',
      requestId: `${message.requestId}-stale`,
      action: 'status',
      installed: true,
      registered: true,
      enabled: true,
      version: '1.11.0',
    }),
  }
  const lifecycle = new NativeInputLifecycle({ host })
  await assert.rejects(lifecycle.status(), /correlation/i)
  assert.equal(lifecycle.snapshot().state, 'error')
})

test('lifecycle startup resets an errored host before restarting it', async () => {
  assert.equal(typeof lifecycleModule.startNativeInputLifecycleHost, 'function')
  const calls = []
  const host = {
    state: 'error',
    async stop(reason) { calls.push(`stop:${reason}`); this.state = 'idle' },
    async start() { calls.push('start'); this.state = 'ready' },
  }
  assert.equal(await lifecycleModule.startNativeInputLifecycleHost(host), false)
  assert.deepEqual(calls, ['stop:lifecycle_reset', 'start'])
})
