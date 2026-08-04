import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import {
  DesktopHostGateway,
  GATEWAY_READY_MESSAGE,
} from '../src/desktop-host-gateway.mjs'

class FakeChild extends EventEmitter {
  constructor(pid) {
    super()
    this.pid = pid
    this.connected = true
    this.stdout = new EventEmitter()
    this.stderr = new EventEmitter()
    this.disconnectCalls = 0
  }

  disconnect() {
    this.connected = false
    this.disconnectCalls += 1
  }

  ready(origin = 'http://127.0.0.1:43127') {
    this.emit('message', {
      type: GATEWAY_READY_MESSAGE,
      origin,
    })
  }
}

function createFakeTimers() {
  const scheduled = []
  return {
    scheduled,
    setTimeout(callback, delayMs) {
      const timer = { callback, delayMs, active: true }
      scheduled.push(timer)
      return timer
    },
    clearTimeout(timer) {
      if (timer) timer.active = false
    },
    run(delayMs) {
      const timer = scheduled.find(item => (
        item.active && item.delayMs === delayMs
      ))
      assert.ok(timer, `missing active ${delayMs}ms timer`)
      timer.active = false
      timer.callback()
    },
  }
}

function harness({
  startupTimeoutMs = 15_000,
  stopTimeoutMs = 5_000,
} = {}) {
  const children = []
  const forks = []
  const kills = []
  const timers = createFakeTimers()
  const gateway = new DesktopHostGateway({
    entryPath: '/runtime/server/src/index.mjs',
    environment: {
      PATH: '/usr/bin',
      DASHSCOPE_API_KEY: 'must-not-appear',
    },
    startupTimeoutMs,
    stopTimeoutMs,
    timers,
    forkImpl(entry, args, options) {
      const child = new FakeChild(4100 + children.length)
      children.push(child)
      forks.push({ entry, args, options, child })
      return child
    },
    killImpl(pid, signal) {
      kills.push([pid, signal])
      const child = children.find(item => item.pid === Math.abs(pid))
      queueMicrotask(() => child?.emit('exit', 0, signal))
    },
  })
  return { children, forks, gateway, kills, timers }
}

test('starts a detached port-zero Gateway and adopts its ready origin', async () => {
  const target = harness()
  const statuses = []
  target.gateway.on('status', status => statuses.push(status))

  const started = target.gateway.start()
  assert.equal(target.forks.length, 1)
  assert.equal(target.forks[0].entry, '/runtime/server/src/index.mjs')
  assert.deepEqual(target.forks[0].args, [])
  assert.equal(target.forks[0].options.detached, true)
  assert.deepEqual(target.forks[0].options.stdio, [
    'ignore',
    'pipe',
    'pipe',
    'ipc',
  ])
  assert.equal(target.forks[0].options.env.HOST, '127.0.0.1')
  assert.equal(target.forks[0].options.env.PORT, '0')
  target.children[0].ready()

  assert.equal(await started, 'http://127.0.0.1:43127')
  assert.equal(target.gateway.running, true)
  assert.deepEqual(statuses.map(status => status.state), [
    'starting',
    'ready',
  ])
})

test('rejects a non-loopback ready origin and kills only the owned group', async () => {
  const target = harness()
  const started = target.gateway.start()
  target.children[0].ready('http://192.168.1.30:43127')

  await assert.rejects(started, /loopback/i)
  assert.deepEqual(target.kills, [[-4100, 'SIGTERM']])
  assert.equal(target.gateway.running, false)
})

test('times out startup and kills only the owned process group', async () => {
  const target = harness({ startupTimeoutMs: 90 })
  const started = target.gateway.start()
  target.timers.run(90)

  await assert.rejects(started, /timed out/i)
  assert.deepEqual(target.kills, [[-4100, 'SIGTERM']])
})

test('rejects an exit before ready without killing an already-exited group', async () => {
  const target = harness()
  const started = target.gateway.start()
  target.children[0].emit('exit', 7, null)

  await assert.rejects(started, /exited before ready \(7\)/)
  assert.deepEqual(target.kills, [])
  assert.equal(target.gateway.running, false)
})

test('treats an absent owned process group as already stopped', async () => {
  const child = new FakeChild(5100)
  const missing = new Error('missing process')
  missing.code = 'ESRCH'
  const gateway = new DesktopHostGateway({
    entryPath: '/runtime/server/src/index.mjs',
    forkImpl: () => child,
    killImpl: () => {
      throw missing
    },
    startupTimeoutMs: 20,
  })
  const started = gateway.start()
  child.ready('http://example.com:43127')

  await assert.rejects(started, /loopback/i)
  assert.equal(gateway.running, false)
})

test('gracefully disconnects before stopping the owned process group', async () => {
  const target = harness({ stopTimeoutMs: 75 })
  const started = target.gateway.start()
  target.children[0].ready()
  await started

  const stopped = target.gateway.stop()
  assert.equal(target.children[0].disconnectCalls, 1)
  assert.deepEqual(target.kills, [])
  target.timers.run(75)
  await stopped

  assert.deepEqual(target.kills, [[-4100, 'SIGTERM']])
  assert.equal(target.gateway.running, false)
})

test('recovers unexpected exits after 1, 2, and 4 seconds then stops', async () => {
  const target = harness()
  const statuses = []
  target.gateway.on('status', status => statuses.push(status))
  const started = target.gateway.start()
  target.children[0].ready()
  await started

  for (const [index, delayMs] of [1_000, 2_000, 4_000].entries()) {
    target.children[index].emit('exit', 1, null)
    const recovering = statuses.at(-1)
    assert.equal(recovering.state, 'recovering')
    assert.equal(recovering.retry, index + 1)
    assert.equal(recovering.delayMs, delayMs)
    target.timers.run(delayMs)
    assert.equal(target.children.length, index + 2)
    target.children[index + 1].ready(`http://127.0.0.1:${43128 + index}`)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(target.gateway.running, true)
  }

  target.children[3].emit('exit', 1, null)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(target.children.length, 4)
  assert.equal(statuses.at(-1).state, 'error')
  assert.equal(statuses.at(-1).retry, 3)
})

test('keeps a bounded redacted line-oriented Gateway log', async () => {
  const target = harness()
  const started = target.gateway.start()
  target.children[0].stdout.emit('data', Buffer.from(
    'token=first-secret\npartial',
  ))
  target.children[0].stdout.emit('data', Buffer.from(' line\n'))
  target.children[0].stderr.emit('data', Buffer.from(
    'Authorization: Bearer second-secret\n',
  ))
  target.children[0].ready()
  await started

  assert.deepEqual(target.gateway.tailLogs({ limit: 2 }), [
    { stream: 'stdout', message: 'partial line' },
    {
      stream: 'stderr',
      message: 'Authorization=[REDACTED] [REDACTED]',
    },
  ])
  assert.doesNotMatch(
    JSON.stringify(target.gateway.tailLogs({ limit: 3 })),
    /first-secret|second-secret/,
  )
  assert.throws(() => target.gateway.tailLogs({ limit: 0 }), /between 1 and 500/)

  for (let index = 0; index < 505; index += 1) {
    target.children[0].stdout.emit('data', Buffer.from(`line-${index}\n`))
  }
  const bounded = target.gateway.tailLogs({ limit: 500 })
  assert.equal(bounded.length, 500)
  assert.equal(bounded[0].message, 'line-5')
  assert.equal(bounded.at(-1).message, 'line-504')
})
