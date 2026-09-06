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

// Local audio can start almost immediately. Remote Gateway transports need a
// small jitter reserve so network variance does not leave gaps between PCM
// chunks already scheduled on the Web Audio timeline.
export function audioPlaybackLeadSeconds({ remote = false } = {}) {
  return remote ? 0.16 : 0.02
}
