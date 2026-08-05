import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { detectBackendSetups } from '../src/backend-detection.mjs'

class SuccessfulWorker extends EventEmitter {
  constructor(url, options) {
    super()
    this.url = url
    this.options = options
    queueMicrotask(() => this.emit('message', {
      ok: true,
      path: '/usr/bin:/agent/bin',
      report: { selected: 'opencode', backends: [] },
    }))
  }
}

class FailedWorker extends EventEmitter {
  constructor() {
    super()
    queueMicrotask(() => this.emit('message', {
      ok: false,
      error: '检测失败',
    }))
  }
}

class EmptyWorker extends EventEmitter {
  constructor() {
    super()
    queueMicrotask(() => this.emit('exit', 0))
  }
}

class HangingWorker extends EventEmitter {
  terminate() {
    this.terminated = true
    return Promise.resolve(0)
  }
}

test('runs backend detection outside the caller and returns its compact report', async () => {
  const result = await detectBackendSetups({
    env: { PATH: '/usr/bin' },
    platform: 'darwin',
    WorkerImpl: SuccessfulWorker,
    workerUrl: new URL('file:///worker.mjs'),
  })
  assert.deepEqual(result, {
    path: '/usr/bin:/agent/bin',
    report: { selected: 'opencode', backends: [] },
  })
})

test('surfaces backend detection worker failures', async () => {
  await assert.rejects(
    detectBackendSetups({ WorkerImpl: FailedWorker }),
    /检测失败/,
  )
})

test('does not hang when a backend detection worker exits without a result', async () => {
  await assert.rejects(
    detectBackendSetups({ WorkerImpl: EmptyWorker }),
    /未返回结果/,
  )
})

test('terminates backend detection after the overall timeout', async () => {
  await assert.rejects(
    detectBackendSetups({ WorkerImpl: HangingWorker, timeoutMs: 5 }),
    /检测超时/,
  )
})
