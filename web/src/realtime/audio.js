function sampleRate(value, label) {
  const rate = Number(value)
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new RangeError(`${label} sample rate must be a positive number`)
  }
  return rate
}

function appendSamples(previous, input) {
  const samples = new Float32Array(previous.length + input.length)
  samples.set(previous)
  samples.set(input, previous.length)
  return samples
}

const textEncoder = new TextEncoder()

/**
 * Resamples one continuous PCM stream while retaining the interpolation phase
 * between input chunks. The stream can be reset when a capture or target rate
 * changes; flush() emits the final clamped sample and starts a new stream.
 */
export function createStreamingResampler() {
  let inputRate = 0
  let outputRate = 0
  let pending = new Float32Array(0)
  let position = 0
  let totalInput = 0
  let outputCount = 0

  const reset = () => {
    inputRate = 0
    outputRate = 0
    pending = new Float32Array(0)
    position = 0
    totalInput = 0
    outputCount = 0
  }

  const configure = (from, to) => {
    const sourceRate = sampleRate(from, 'input')
    const targetRate = sampleRate(to, 'output')
    if (sourceRate !== inputRate || targetRate !== outputRate) {
      reset()
      inputRate = sourceRate
      outputRate = targetRate
    }
    return [sourceRate, targetRate]
  }

  const emit = final => {
    const ratio = inputRate / outputRate
    const targetCount = Math.max(1, Math.round(totalInput / ratio))
    const values = []
    while (position + 1 < pending.length && outputCount < targetCount) {
      const before = Math.floor(position)
      const fraction = position - before
      const after = Math.min(pending.length - 1, before + 1)
      values.push(pending[before] * (1 - fraction) + pending[after] * fraction)
      position += ratio
      outputCount += 1
    }
    if (final) {
      while (position < pending.length && outputCount < targetCount) {
        const before = Math.floor(position)
        const fraction = position - before
        const after = Math.min(pending.length - 1, before + 1)
        values.push(pending[before] * (1 - fraction) + pending[after] * fraction)
        position += ratio
        outputCount += 1
      }
    }

    const consumed = Math.min(pending.length, Math.floor(position))
    if (consumed > 0) {
      pending = pending.slice(consumed)
      position -= consumed
    }
    return Float32Array.from(values)
  }

  return {
    process(input, from, to) {
      if (!input?.length) return new Float32Array(0)
      const [sourceRate, targetRate] = configure(from, to)
      if (sourceRate === targetRate) return input
      pending = appendSamples(pending, input)
      totalInput += input.length
      return emit(false)
    },
    flush() {
      if (!inputRate || !outputRate || inputRate === outputRate) {
        reset()
        return new Float32Array(0)
      }
      const output = emit(true)
      reset()
      return output
    },
    reset,
  }
}

export function resample(input, from, to) {
  if (!input?.length) return new Float32Array(0)
  if (from === to) return input
  const stream = createStreamingResampler()
  const first = stream.process(input, from, to)
  const last = stream.flush()
  if (!first.length) return last
  if (!last.length) return first
  const output = new Float32Array(first.length + last.length)
  output.set(first)
  output.set(last, first.length)
  return output
}

export function pcmBase64(samples) {
  const bytes = new Uint8Array(samples.length * 2)
  const view = new DataView(bytes.buffer)
  samples.forEach((sample, index) => {
    const clamped = Math.max(-1, Math.min(1, sample))
    view.setInt16(index * 2, clamped * 0x7fff, true)
  })
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }
  return btoa(binary)
}

export function decodePcm(base64) {
  const binary = atob(base64)
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
  const view = new DataView(bytes.buffer)
  const output = new Float32Array(bytes.length / 2)
  for (let index = 0; index < output.length; index += 1) {
    output[index] = view.getInt16(index * 2, true) / 0x8000
  }
  return output
}

export const REALTIME_AUDIO_SEND_HIGH_WATER_BYTES = 64 * 1024
export const REALTIME_AUDIO_SEND_LOW_WATER_BYTES = 16 * 1024

function serializedByteLength(value) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value)
  return typeof serialized === 'string'
    ? textEncoder.encode(serialized).byteLength
    : 0
}

/**
 * Limits realtime microphone sends to the transport buffer's high-water mark.
 * Audio is a live stream, so dropping a chunk while the socket is congested is
 * preferable to retaining seconds of stale audio and increasing turn latency.
 * Control messages continue to use GatewayClient.send directly.
 */
export function createRealtimeAudioSendController({
  send,
  getBufferedAmount = () => 0,
  highWaterMarkBytes = REALTIME_AUDIO_SEND_HIGH_WATER_BYTES,
  lowWaterMarkBytes = REALTIME_AUDIO_SEND_LOW_WATER_BYTES,
  onDrop,
} = {}) {
  if (typeof send !== 'function') throw new TypeError('send is required')

  const highWater = Math.max(1, Number(highWaterMarkBytes) || 0)
  const lowWater = Math.max(
    0,
    Math.min(highWater, Number(lowWaterMarkBytes) || 0),
  )
  let congested = false
  let droppedCount = 0

  const bufferedAmount = () => {
    try {
      const value = Number(getBufferedAmount())
      return Number.isFinite(value) && value > 0 ? value : 0
    } catch {
      return 0
    }
  }

  const drop = (buffered, payloadBytes) => {
    droppedCount += 1
    try {
      onDrop?.({
        bufferedAmount: buffered,
        payloadBytes,
        droppedCount,
      })
    } catch {
      // A telemetry callback must never interrupt microphone processing.
    }
  }

  return {
    send(event) {
      const buffered = bufferedAmount()
      const payloadBytes = serializedByteLength(event)
      if (congested && buffered > lowWater) {
        drop(buffered, payloadBytes)
        return false
      }
      congested = false

      if (buffered + payloadBytes > highWater) {
        congested = true
        drop(buffered, payloadBytes)
        return false
      }

      if (!send(event)) return false
      if (bufferedAmount() >= highWater) congested = true
      return true
    },

    reset() {
      congested = false
      droppedCount = 0
    },

    get congested() {
      return congested
    },

    get droppedCount() {
      return droppedCount
    },
  }
}

// Leaves enough Web Audio timeline headroom for a source to be scheduled. The
// transport-specific reserve is real buffered PCM owned by the queue below.
export function audioSchedulingLeadSeconds() {
  return 0.02
}

export function mergePcmPlaybackItems(items = []) {
  const groups = []
  for (const item of items) {
    const previous = groups.at(-1)
    if (
      previous
      && previous.sampleRate === item.sampleRate
      && previous.responseId === item.responseId
    ) {
      previous.items.push(item)
      previous.length += item.samples.length
      continue
    }
    groups.push({
      sampleRate: item.sampleRate,
      responseId: item.responseId,
      items: [item],
      length: item.samples.length,
    })
  }
  return groups.map(group => {
    const samples = new Float32Array(group.length)
    let offset = 0
    for (const item of group.items) {
      samples.set(item.samples, offset)
      offset += item.samples.length
    }
    return {
      samples,
      sampleRate: group.sampleRate,
      responseId: group.responseId,
      duration: samples.length / group.sampleRate,
    }
  })
}

/**
 * Buffers bursty PCM delivery without coupling playback to a transport. Local
 * clients flush every chunk immediately. Remote clients build an initial
 * reserve, then coalesce small chunks and rebuild the reserve after underruns.
 */
export function createPcmPlaybackQueue({
  remote = false,
  onFlush,
  initialBufferSeconds = 0.4,
  resumeBufferSeconds = 0.32,
  lowWaterSeconds = 0.12,
  batchSeconds = 0.1,
  batchDelayMs = 60,
  schedule = (callback, delay) => setTimeout(callback, delay),
  cancel = timer => clearTimeout(timer),
} = {}) {
  if (typeof onFlush !== 'function') throw new TypeError('onFlush is required')

  let pending = []
  let pendingSeconds = 0
  let flushTimer = null
  let started = false
  let buffering = remote

  const clearFlushTimer = () => {
    if (flushTimer !== null) cancel(flushTimer)
    flushTimer = null
  }

  const flush = () => {
    clearFlushTimer()
    if (!pending.length) return
    const items = pending
    pending = []
    pendingSeconds = 0
    started = true
    buffering = false
    onFlush(mergePcmPlaybackItems(items))
  }

  const scheduleBatchFlush = () => {
    if (flushTimer !== null) return
    flushTimer = schedule(() => {
      flushTimer = null
      flush()
    }, batchDelayMs)
  }

  return {
    push(item, { timelineAheadSeconds = 0 } = {}) {
      if (!remote) {
        onFlush([item])
        return
      }
      if (started && timelineAheadSeconds <= lowWaterSeconds) buffering = true
      pending.push(item)
      pendingSeconds += item.duration
      const target = buffering
        ? (started ? resumeBufferSeconds : initialBufferSeconds)
        : batchSeconds
      if (pendingSeconds >= target) flush()
      else if (!buffering) scheduleBatchFlush()
    },
    finish() {
      flush()
    },
    responseIds() {
      return [...new Set(pending.map(item => item.responseId).filter(Boolean))]
    },
    reset() {
      clearFlushTimer()
      pending = []
      pendingSeconds = 0
      started = false
      buffering = remote
    },
  }
}
