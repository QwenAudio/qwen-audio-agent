import test from 'node:test'
import assert from 'node:assert/strict'
import {
  fft, barEnergies, drawSpectrumI420, createSpectrumRenderer,
  DEFAULT_FFT_SIZE, DEFAULT_BARS,
} from '../providers/mock/spectrum.mjs'

const SAMPLE_RATE = 24000

// A pure tone window (Float32, -1..1) for the spectrum assertions.
function toneWindow(frequency, { size = DEFAULT_FFT_SIZE, amplitude = 0.5 } = {}) {
  const window = new Float32Array(size)
  for (let i = 0; i < size; i++) window[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / SAMPLE_RATE)
  return window
}

function toneInt16(frequency, { size = DEFAULT_FFT_SIZE, amplitude = 0.5 } = {}) {
  const pcm = new Int16Array(size)
  for (let i = 0; i < size; i++) pcm[i] = Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * frequency * i) / SAMPLE_RATE))
  return pcm
}

function argmax(levels) {
  let best = 0
  for (let i = 1; i < levels.length; i++) if (levels[i] > levels[best]) best = i
  return best
}

function maxLuma(buffer) {
  const ySize = buffer.length / 1.5
  let max = 0
  for (let i = 0; i < ySize; i++) if (buffer[i] > max) max = buffer[i]
  return max
}

test('fft concentrates a pure cosine into its bin', () => {
  const n = 256
  const k = 5
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * k * i) / n)
  fft(re, im)
  const mag = i => Math.hypot(re[i], im[i])
  assert.ok(mag(k) > n * 0.4, `bin ${k} should hold the energy, got ${mag(k)}`)
  assert.ok(mag(k) > mag(k + 3) * 10, 'energy must be concentrated, not smeared')
})

test('fft rejects non power-of-two and mismatched lengths', () => {
  assert.throws(() => fft(new Float64Array(3), new Float64Array(3)), TypeError)
  assert.throws(() => fft(new Float64Array(4), new Float64Array(8)), TypeError)
})

test('barEnergies peaks at the bar containing a 440 Hz tone', () => {
  const levels = barEnergies(toneWindow(440), { sampleRate: SAMPLE_RATE })
  assert.equal(levels.length, DEFAULT_BARS)
  const peak = argmax(levels)
  // 440 Hz lands in log bar 10 for [80, 8000] Hz over 28 bars; allow ±1 for
  // Hann-window leakage across the band boundary.
  assert.ok(Math.abs(peak - 10) <= 1, `expected peak near bar 10, got ${peak}`)
  assert.ok(levels[peak] > levels[0], 'mid band must dominate the lowest band')
  assert.ok(levels[peak] > levels[DEFAULT_BARS - 1], 'mid band must dominate the highest band')
  assert.ok(levels[peak] > 0.3, `peak bar should be strong, got ${levels[peak]}`)
})

test('barEnergies of silence is flat zero', () => {
  const levels = barEnergies(new Float32Array(DEFAULT_FFT_SIZE), { sampleRate: SAMPLE_RATE })
  for (const level of levels) assert.ok(level < 1e-6, `silence must produce no energy, got ${level}`)
})

test('barEnergies shifts the peak with frequency', () => {
  const low = argmax(barEnergies(toneWindow(200), { sampleRate: SAMPLE_RATE }))
  const high = argmax(barEnergies(toneWindow(3000), { sampleRate: SAMPLE_RATE }))
  assert.ok(high > low, `3 kHz bar (${high}) must sit above 200 Hz bar (${low})`)
})

test('drawSpectrumI420 produces an exact-size buffer and is deterministic', () => {
  const levels = new Float32Array(DEFAULT_BARS).fill(0.6)
  const a = drawSpectrumI420({ width: 256, height: 256, levels })
  const b = drawSpectrumI420({ width: 256, height: 256, levels })
  assert.equal(a.length, 256 * 256 * 3 / 2)
  assert.ok(a.equals(b), 'same levels must draw the same frame')
})

test('drawSpectrumI420 paints bars above background and respects zero levels', () => {
  const lit = drawSpectrumI420({ width: 256, height: 256, levels: new Float32Array(DEFAULT_BARS).fill(1) })
  assert.ok(maxLuma(lit) > 120, 'full bars must be bright')
  const dark = drawSpectrumI420({ width: 256, height: 256, levels: new Float32Array(DEFAULT_BARS) })
  assert.equal(maxLuma(dark), 16, 'zero levels leave only the background')
})

test('drawSpectrumI420 rejects odd dimensions', () => {
  assert.throws(() => drawSpectrumI420({ width: 63, height: 64, levels: new Float32Array(4) }), TypeError)
})

test('createSpectrumRenderer reacts to loud PCM and stays dark on silence', () => {
  const loud = createSpectrumRenderer({ width: 256, height: 256, sampleRate: SAMPLE_RATE })
  loud.push(toneInt16(440))
  assert.ok(maxLuma(loud.frame()) > 120, 'a loud tone must light up the spectrum')

  const quiet = createSpectrumRenderer({ width: 256, height: 256, sampleRate: SAMPLE_RATE })
  quiet.push(new Int16Array(DEFAULT_FFT_SIZE))
  assert.equal(maxLuma(quiet.frame()), 16, 'silence must leave the background only')
})

test('createSpectrumRenderer smooths a sudden drop over subsequent frames', () => {
  const renderer = createSpectrumRenderer({ width: 256, height: 256, sampleRate: SAMPLE_RATE })
  renderer.push(toneInt16(440))
  const peak = maxLuma(renderer.frame())
  assert.ok(peak > 120)
  // Feed silence; the release coefficient must decay the bars gradually, not
  // snap to background in a single frame.
  renderer.push(new Int16Array(DEFAULT_FFT_SIZE))
  const decaying = maxLuma(renderer.frame())
  assert.ok(decaying > 16, 'bars must not vanish instantly after the tone stops')
  // Smoothing advances per rendered frame, so render each silent frame.
  for (let i = 0; i < 80; i++) { renderer.push(new Int16Array(960)); renderer.frame() }
  assert.equal(maxLuma(renderer.frame()), 16, 'bars must settle to background after enough silence')
})
