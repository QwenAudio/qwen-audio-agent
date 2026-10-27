/* global AudioWorkletProcessor, registerProcessor, sampleRate */
// Streaming box-filter resampling preserves fractional source-sample positions
// across render quanta (including 44.1 kHz), then emits 20 ms PCM16LE packets.
class DigitalHumanMicrophone extends AudioWorkletProcessor {
  constructor() {
    super()
    this.ratio = sampleRate / 16_000
    this.remaining = this.ratio
    this.sum = 0
    this.packet = new ArrayBuffer(320 * 2)
    this.view = new DataView(this.packet)
    this.offset = 0
  }

  process(inputs) {
    const samples = inputs[0]?.[0]
    if (!samples) return true
    for (const sample of samples) {
      let width = 1
      while (width > 1e-8) {
        const part = Math.min(width, this.remaining)
        this.sum += sample * part
        this.remaining -= part
        width -= part
        if (this.remaining > 1e-8) continue
        const value = Math.max(-1, Math.min(1, this.sum / this.ratio))
        this.view.setInt16(this.offset * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true)
        this.offset += 1
        this.sum = 0
        this.remaining = this.ratio
        if (this.offset === 320) {
          this.port.postMessage(this.packet, [this.packet])
          this.packet = new ArrayBuffer(640)
          this.view = new DataView(this.packet)
          this.offset = 0
        }
      }
    }
    return true
  }
}

registerProcessor('digital-human-microphone', DigitalHumanMicrophone)
