import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { createMicrophoneAudioWorkletNode } from '../src/realtime/microphone-audio-worklet.js'

class FakePort {
  constructor() {
    this.listeners = new Set()
    this.closed = false
    this.started = false
  }

  addEventListener(name, listener) {
    if (name === 'message') this.listeners.add(listener)
  }

  removeEventListener(name, listener) {
    if (name === 'message') this.listeners.delete(listener)
  }

  emit(data) {
    if (!this.started || this.closed) return
    for (const listener of this.listeners) listener({ data })
  }

  start() {
    this.started = true
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
  assert.equal(first.node.port.started, true)
  assert.equal(second.node.port.started, true)
  first.node.port.emit({ type: 'samples', samples: Float32Array.from([0.1, 0.2]).buffer })
  second.node.port.emit({ type: 'samples', samples: Float32Array.from([0.3]).buffer })
  assert.deepEqual(
    received.map(samples => samples.map(value => Number(value.toFixed(5)))),
    [[0.1, 0.2], [0.3]],
  )

  first.close()
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

test('retries processor module loading after a failure', async () => {
  const { context } = contextFixture()
  let attempts = 0
  context.audioWorklet.addModule = async () => {
    if (++attempts === 1) throw new Error('Module load failed')
  }
  const options = { context, moduleUrl: '/worklet.js', nodeConstructor: FakeAudioWorkletNode, onSamples() {} }
  await assert.rejects(createMicrophoneAudioWorkletNode(options), /Module load failed/)
  const capture = await createMicrophoneAudioWorkletNode(options)
  assert.equal(attempts, 2)
  capture.close()
})

test('standalone processor transfers copied samples and never echoes microphone input', async () => {
  const messages = []
  let registered
  const source = await readFile(new URL('../src/realtime/microphone-audio-worklet-processor.js', import.meta.url), 'utf8')
  runInNewContext(source, {
    AudioWorkletProcessor: class {
      constructor() {
        this.port = { postMessage: (data, transfers) => messages.push({ data, transfers }) }
      }
    },
    registerProcessor: (name, Processor) => { registered = { name, Processor } },
  })
  const { context } = contextFixture()
  const capture = await createMicrophoneAudioWorkletNode({
    context, moduleUrl: '/worklet.js', nodeConstructor: FakeAudioWorkletNode, onSamples() {},
  })
  assert.equal(registered.name, capture.node.name)
  const processor = new registered.Processor()
  const input = Float32Array.from([0.25, -0.5, 0.75])
  const output = new Float32Array(3).fill(1)
  assert.equal(processor.process([[input]], [[output]]), true)
  assert.equal(messages[0].data.type, 'samples')
  assert.notEqual(messages[0].data.samples, input.buffer)
  assert.equal(messages[0].transfers[0], messages[0].data.samples)
  assert.deepEqual([...new Float32Array(messages[0].data.samples)], [...input])
  assert.deepEqual([...output], [0, 0, 0])
  processor.process([[]], [[output.fill(1)]])
  assert.equal(messages.length, 1)
  assert.deepEqual([...output], [0, 0, 0])
  capture.close()
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
  const queuedMessage = [...capture.node.port.listeners][0]
  capture.close()
  queuedMessage({ data: { type: 'samples', samples: Float32Array.from([1]).buffer } })
  capture.node.port.emit({ type: 'samples', samples: Float32Array.from([1]).buffer })
  assert.equal(received.length, 0)
})
