export function resample(input, from, to) {
  if (from === to) return input
  const ratio = from / to
  const output = new Float32Array(Math.max(1, Math.round(input.length / ratio)))
  for (let index = 0; index < output.length; index += 1) {
    const position = index * ratio
    const before = Math.floor(position)
    const after = Math.min(input.length - 1, before + 1)
    output[index] = input[before] * (1 - position + before) + input[after] * (position - before)
  }
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
