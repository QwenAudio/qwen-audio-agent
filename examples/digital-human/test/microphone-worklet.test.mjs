import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../client/microphone-worklet.js', import.meta.url), 'utf8')
function worklet(sampleRate) {
  const packets = []
  let Processor
  runInNewContext(source, {
    sampleRate,
    AudioWorkletProcessor: class {
      constructor() { this.port = { postMessage: packet => packets.push(Buffer.from(packet)) } }
    },
    registerProcessor: (_name, implementation) => { Processor = implementation },
  })
  return { node: new Processor(), packets }
}

for (const rate of [16_000, 44_100, 48_000]) {
  test(`microphone resamples ${rate} Hz to exact 20 ms PCM16LE packets`, () => {
    const { node, packets } = worklet(rate)
    // Feed one second in real AudioWorklet render quanta; the fractional
    // resampling position must survive every process() boundary.
    for (let offset = 0; offset < rate; offset += 128) {
      node.process([[new Float32Array(Math.min(128, rate - offset)).fill(0.5)]])
    }
    assert.equal(packets.length, 50)
    assert.ok(packets.every(packet => packet.length === 640))
    for (const packet of packets) {
      for (let index = 0; index < packet.length; index += 2) assert.ok(Math.abs(packet.readInt16LE(index) - 16384) <= 1)
    }
  })
}

test('microphone clips PCM16 and emits nothing without capture input', () => {
  const { node, packets } = worklet(16_000)
  node.process([])
  assert.equal(packets.length, 0)
  const samples = new Float32Array(320)
  samples[0] = -2
  samples[1] = 2
  node.process([[samples]])
  assert.equal(packets[0].readInt16LE(0), -32768)
  assert.equal(packets[0].readInt16LE(2), 32767)
})
