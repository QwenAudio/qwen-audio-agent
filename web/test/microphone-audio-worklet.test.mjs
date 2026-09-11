import assert from 'node:assert/strict'
import test from 'node:test'
import { createMicrophoneAudioWorkletNode } from '../src/realtime/microphone-audio-worklet.js'

class FakePort {
  constructor() {
    this.listeners = new Set()
    this.closed = false
  }

  addEventListener(name, listener) {
    if (name === 'message') this.listeners.add(listener)
  }

  removeEventListener(name, listener) {
    if (name === 'message') this.listeners.delete(listener)
  }

  emit(data) {
    for (const listener of this.listeners) listener({ data })
  }

  close() {
    this.closed = true
  }
}

class FakeAudioWorkletNode {
  constructor(context, name, options) {
    this.context = context
    this.name = name
    this.options = options
    this.port = new FakePort()
    this.disconnected = false
  }

  disconnect() {
    this.disconnected = true
  }
}

function contextFixture() {
  const modules = []
  return {
    context: {
      audioWorklet: {
        addModule: async url => { modules.push(url) },
      },
    },
    modules,
  }
}

test('loads one processor module per AudioContext and forwards samples', async () => {
  const { context, modules } = contextFixture()
  const received = []
  const first = await createMicrophoneAudioWorkletNode({
    context,
    moduleUrl: '/assets/microphone-worklet.js',
    nodeConstructor: FakeAudioWorkletNode,
    onSamples: samples => received.push([...samples]),
  })
  const second = await createMicrophoneAudioWorkletNode({
    context,
    moduleUrl: '/assets/microphone-worklet.js',
    nodeConstructor: FakeAudioWorkletNode,
    onSamples: samples => received.push([...samples]),
  })

  assert.deepEqual(modules, ['/assets/microphone-worklet.js'])
  assert.equal(first.node.name, 'qwen-audio-microphone')
  assert.equal(first.node.options.numberOfInputs, 1)
  first.node.port.emit({ type: 'samples', samples: Float32Array.from([0.1, 0.2]).buffer })
  second.node.port.emit({ type: 'samples', samples: Float32Array.from([0.3]).buffer })
  assert.deepEqual(
    received.map(samples => samples.map(value => Number(value.toFixed(5)))),
    [[0.1, 0.2], [0.3]],
  )

  first.close()
  second.close()
  assert.equal(first.node.port.closed, true)
  assert.equal(first.node.disconnected, true)
})

test('rejects unsupported AudioWorklet contexts', async () => {
  await assert.rejects(
    createMicrophoneAudioWorkletNode({
      context: {},
      moduleUrl: '/assets/microphone-worklet.js',
      nodeConstructor: FakeAudioWorkletNode,
      onSamples() {},
    }),
    error => error.name === 'NotSupportedError',
  )
})

test('does not forward samples after close', async () => {
  const { context } = contextFixture()
  const received = []
  const capture = await createMicrophoneAudioWorkletNode({
    context,
    moduleUrl: '/assets/microphone-worklet.js',
    nodeConstructor: FakeAudioWorkletNode,
    onSamples: samples => received.push(samples),
  })
  capture.close()
  capture.node.port.emit({ type: 'samples', samples: Float32Array.from([1]).buffer })
  assert.equal(received.length, 0)
})
