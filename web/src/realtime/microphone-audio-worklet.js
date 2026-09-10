import { MICROPHONE_AUDIO_WORKLET_PROCESSOR_NAME } from './microphone-audio-worklet-constants.js'

const modulePromises = new WeakMap()

function modulePromise(context, moduleUrl) {
  let modules = modulePromises.get(context)
  if (!modules) {
    modules = new Map()
    modulePromises.set(context, modules)
  }
  let promise = modules.get(moduleUrl)
  if (!promise) {
    promise = context.audioWorklet.addModule(moduleUrl).catch(error => {
      modules.delete(moduleUrl)
      throw error
    })
    modules.set(moduleUrl, promise)
  }
  return promise
}

function toSamples(value) {
  if (value instanceof Float32Array) return value
  if (value instanceof ArrayBuffer) return new Float32Array(value)
  if (ArrayBuffer.isView(value)) {
    return new Float32Array(value.buffer, value.byteOffset, value.byteLength / Float32Array.BYTES_PER_ELEMENT)
  }
  return null
}

export async function createMicrophoneAudioWorkletNode({
  context,
  moduleUrl,
  onSamples,
  nodeConstructor = globalThis.AudioWorkletNode,
} = {}) {
  if (!context?.audioWorklet || typeof context.audioWorklet.addModule !== 'function') {
    throw Object.assign(new Error('AudioWorklet is not available'), { name: 'NotSupportedError' })
  }
  if (!moduleUrl) throw new TypeError('moduleUrl is required')
  if (typeof nodeConstructor !== 'function') {
    throw Object.assign(new Error('AudioWorkletNode is not available'), { name: 'NotSupportedError' })
  }
  if (typeof onSamples !== 'function') throw new TypeError('onSamples is required')

  await modulePromise(context, moduleUrl)
  const node = new nodeConstructor(context, MICROPHONE_AUDIO_WORKLET_PROCESSOR_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  })
  let closed = false
  const handleMessage = event => {
    if (closed || event?.data?.type !== 'samples') return
    const samples = toSamples(event.data.samples)
    if (samples?.length) onSamples(samples)
  }
  node.port.addEventListener?.('message', handleMessage)
  if (!node.port.addEventListener) node.port.onmessage = handleMessage

  return {
    node,
    close() {
      if (closed) return
      closed = true
      node.port.removeEventListener?.('message', handleMessage)
      if (!node.port.removeEventListener) node.port.onmessage = null
      node.port.close?.()
      node.disconnect?.()
    },
  }
}
