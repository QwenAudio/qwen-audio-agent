// Retain filter history and fractional position across chunks. The low-pass
// windowed sinc avoids the aliasing of dropping samples on downsampling.
export class PcmResampler {
  constructor(from, to) {
    if (![from, to].every(rate => Number.isInteger(rate) && rate >= 8000 && rate <= 96000)) throw new RangeError('unsupported PCM sample rate')
    this.from = from
    this.to = to
    this.radius = 16
    this.samples = new Float64Array(this.radius)
    this.position = this.radius
  }

  push(samples, channels = 1) {
    if (![1, 2].includes(channels) || samples.length % channels) throw new TypeError('invalid PCM channels')
    const mono = new Float64Array(samples.length / channels)
    for (let i = 0; i < mono.length; i++) mono[i] = channels === 1 ? samples[i] : (samples[i * 2] + samples[i * 2 + 1]) / 2
    if (this.from === this.to) return Int16Array.from(mono)
    const joined = new Float64Array(this.samples.length + mono.length)
    joined.set(this.samples)
    joined.set(mono, this.samples.length)
    const output = []
    const cutoff = Math.min(1, this.to / this.from) * 0.9
    while (this.position + this.radius < joined.length) {
      let value = 0
      let weight = 0
      for (let i = Math.ceil(this.position - this.radius); i <= Math.floor(this.position + this.radius); i++) {
        const distance = i - this.position
        const x = Math.PI * distance * cutoff
        const sinc = Math.abs(x) < 1e-9 ? 1 : Math.sin(x) / x
        const coefficient = sinc * (0.5 + 0.5 * Math.cos(Math.PI * distance / this.radius))
        value += joined[i] * coefficient
        weight += coefficient
      }
      output.push(Math.max(-32768, Math.min(32767, Math.round(value / weight))))
      this.position += this.from / this.to
    }
    const consumed = Math.max(0, Math.floor(this.position) - this.radius)
    this.samples = joined.slice(consumed)
    this.position -= consumed
    return Int16Array.from(output)
  }

  finish() {
    return this.from === this.to ? new Int16Array() : this.push(new Int16Array(this.radius + 1))
  }
}

export function decodePcm(audio) {
  if (typeof audio !== 'string' || audio.length > 2 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(audio)) throw new TypeError('invalid PCM payload')
  const bytes = Buffer.from(audio, 'base64')
  if (bytes.length % 2) throw new TypeError('PCM16 requires an even byte length')
  const samples = new Int16Array(bytes.length / 2)
  for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(i * 2)
  return samples
}

export function encodePcm(samples) {
  const bytes = Buffer.allocUnsafe(samples.length * 2)
  for (let i = 0; i < samples.length; i++) bytes.writeInt16LE(samples[i], i * 2)
  return bytes.toString('base64')
}
