function validSampleRate(value) {
  const rate = Number(value)
  return Number.isFinite(rate) && rate > 0 ? rate : 0
}

/**
 * Convert mono little-endian PCM16 to the playback device rate.
 *
 * Realtime providers negotiate a preferred output rate with the Gateway, but
 * each audio event remains self-describing. Keeping this conversion in the
 * TUI audio boundary lets every provider use the same playback path and also
 * protects against a server that returns a different valid rate.
 */
export function resamplePcm16(buffer, sourceRate, targetRate) {
  const input = Buffer.from(buffer)
  const fromRate = validSampleRate(sourceRate)
  const toRate = validSampleRate(targetRate)
  if (!fromRate || !toRate) throw new Error('音频采样率无效')
  if (input.length % 2 !== 0) throw new Error('PCM16 音频长度必须为偶数')
  if (!input.length || fromRate === toRate) return input

  const inputFrames = input.length / 2
  const outputFrames = Math.max(1, Math.round(inputFrames * toRate / fromRate))
  const output = Buffer.allocUnsafe(outputFrames * 2)

  for (let index = 0; index < outputFrames; index += 1) {
    const position = index * fromRate / toRate
    const left = Math.min(Math.floor(position), inputFrames - 1)
    const right = Math.min(left + 1, inputFrames - 1)
    const fraction = position - left
    const leftSample = input.readInt16LE(left * 2)
    const rightSample = input.readInt16LE(right * 2)
    const sample = Math.round(leftSample + (rightSample - leftSample) * fraction)
    output.writeInt16LE(sample, index * 2)
  }

  return output
}
