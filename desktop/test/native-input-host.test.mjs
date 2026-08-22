import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { NativeInputHost } from '../src/native-input-host.mjs'
import {
  NativeInputFrameDecoder,
  encodeNativeInputFrame,
} from '../src/native-input-protocol.mjs'

function fakeChild() {
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.killCalls = []
  child.kill = signal => {
    child.killCalls.push(signal)
    return true
  }
  return child
}

function harness(overrides = {}) {
  const child = overrides.child || fakeChild()
  const spawns = []
  const emergencyStops = []
  const host = new NativeInputHost({
    resolveArtifact: () => '/Applications/Qwen.app/Contents/Resources/native-input/QwenInputBridge',
    spawnImpl: (path, args, options) => {
      spawns.push({ path, args, options })
      return child
    },
    environment: {
      PATH: '/usr/bin:/bin',
      TMPDIR: '/private/tmp/',
      LANG: 'en_US.UTF-8',
      DASHSCOPE_API_KEY: 'must-not-cross',
      QWEN_AUDIO_DICTATION_API_KEY: 'must-not-cross-either',
    },
    startupTimeoutMs: 50,
    stopTimeoutMs: 10,
    onEmergencyStop: reason => emergencyStops.push(reason),
    ...overrides,
  })
  return { child, emergencyStops, host, spawns }
}

function reportReady(child) {
  child.stdout.write(encodeNativeInputFrame({
    type: 'bridge.ready',
    state: 'ready',
  }))
}

test('starts one owned child with a fixed executable and scrubbed environment', async () => {
  const { child, host, spawns } = harness()
  const pending = host.start()
  assert.equal(host.state, 'starting')
  assert.equal(spawns.length, 1)
  assert.deepEqual(spawns[0], {
    path: '/Applications/Qwen.app/Contents/Resources/native-input/QwenInputBridge',
    args: [],
    options: {
      detached: false,
      env: {
        LANG: 'en_US.UTF-8',
        PATH: '/usr/bin:/bin',
        TMPDIR: '/private/tmp/',
      },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  })
  assert.equal(await Promise.race([
    pending.then(() => 'ready'),
    Promise.resolve('pending'),
  ]), 'pending')

  reportReady(child)
  assert.deepEqual(await pending, { state: 'ready' })
  assert.equal(host.state, 'ready')
  assert.deepEqual(await host.start(), { state: 'ready' })
  assert.equal(spawns.length, 1)
})
test('malformed bridge output fails closed and rejects later operations', async () => {
  const { child, emergencyStops, host } = harness()
  const pending = host.start()
  child.stdout.write(Buffer.from([0, 0, 0, 0]))

  await assert.rejects(pending, /zero|frame|payload/i)
  assert.equal(host.state, 'error')
  assert.deepEqual(emergencyStops, ['malformed_output'])
  assert.equal(child.killCalls.length, 1)
  assert.throws(
    () => host.send({ type: 'session.partial', text: 'secret' }),
    /not ready/i,
  )
})

test('unexpected child exit and startup timeout invoke emergency stop', async () => {
  const exited = harness()
  const ready = exited.host.start()
  reportReady(exited.child)
  await ready
  exited.child.emit('exit', 9, null)
  assert.equal(exited.host.state, 'error')
  assert.deepEqual(exited.emergencyStops, ['child_exit'])

  const timedOut = harness({ startupTimeoutMs: 5 })
  await assert.rejects(timedOut.host.start(), /timed out/i)
  assert.equal(timedOut.host.state, 'error')
  assert.deepEqual(timedOut.emergencyStops, ['startup_timeout'])
})

test('graceful stop sends one typed stop frame then bounds the owned child', async () => {
  const { child, host } = harness()
  const pending = host.start()
  reportReady(child)
  await pending

  const frames = []
  const decoder = new NativeInputFrameDecoder()
  child.stdin.on('data', chunk => frames.push(...decoder.push(chunk)))

  await host.stop('desktop_shutdown')
  assert.deepEqual(frames, [{
    type: 'bridge.stop',
    reason: 'desktop_shutdown',
  }])
  assert.deepEqual(child.killCalls, ['SIGTERM'])
  assert.equal(host.state, 'idle')
  assert.throws(
    () => host.send({ type: 'session.final', text: 'after stop' }),
    /not ready/i,
  )
})

test('a clean Bridge exit during stop never triggers emergency handling', async () => {
  const { child, emergencyStops, host } = harness({ stopTimeoutMs: 100 })
  const pending = host.start()
  reportReady(child)
  await pending

  const stopping = host.stop('desktop_shutdown')
  child.emit('exit', 0, null)
  await stopping
  assert.equal(host.state, 'idle')
  assert.deepEqual(emergencyStops, [])
  assert.deepEqual(child.killCalls, [])
})

test('correlates requests and rejects timeout and late responses after stop', async () => {
  const { child, host } = harness({ requestTimeoutMs: 5 })
  const pending = host.start()
  reportReady(child)
  await pending

  const frames = []
  const decoder = new NativeInputFrameDecoder()
  child.stdin.on('data', chunk => frames.push(...decoder.push(chunk)))

  const status = host.request({ type: 'lifecycle.status' })
  await new Promise(resolve => setImmediate(resolve))
  const request = frames.at(-1)
  child.stdout.write(encodeNativeInputFrame({
    type: 'lifecycle.result',
    requestId: request.requestId,
    action: 'status',
    installed: true,
    registered: true,
    enabled: false,
    version: '1.11.0',
  }))
  assert.equal((await status).requestId, request.requestId)

  await assert.rejects(
    host.request({ type: 'lifecycle.status' }),
    /timed out/i,
  )

  const late = host.request({ type: 'lifecycle.status' })
  await new Promise(resolve => setImmediate(resolve))
  const lateRequest = frames.at(-1)
  const stopping = host.stop('test_stop')
  child.emit('exit', 0, null)
  await stopping
  await assert.rejects(late, /stopped/i)
  child.stdout.write(encodeNativeInputFrame({
    type: 'lifecycle.result',
    requestId: lateRequest.requestId,
    action: 'status',
    installed: true,
    registered: true,
    enabled: true,
    version: '1.11.0',
  }))
  assert.equal(host.state, 'idle')
})
