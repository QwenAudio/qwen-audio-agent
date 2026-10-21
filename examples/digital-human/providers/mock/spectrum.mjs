// Audio-reactive spectrum visualizer for the mock avatar renderer.
//
// The mock renderer echoes the assistant reply PCM back as the avatar's paired
// audio. To make the avatar video meaningful instead of a scrolling test
// pattern, we visualize that same PCM as a music-player-style bar spectrum: an
// FFT over a rolling window of recent samples drives N log-spaced bars whose
// overall height tracks loudness and whose shape tracks frequency content. The
// bars are drawn into the I420 frame published alongside the audio, so because
// they come from the exact PCM in that unit, video stays in sync with audio by
// construction.
//
// The pure functions (fft, barEnergies, drawSpectrumI420) are unit-testable on
// their own; createSpectrumRenderer adds the rolling window + peak smoothing
// the renderer needs across frames.

export const DEFAULT_FFT_SIZE = 1024
export const DEFAULT_BARS = 28
export const DEFAULT_MIN_HZ = 80
export const DEFAULT_MAX_HZ = 8000

function clampByte(value) {
  return value < 0 ? 0 : value > 255 ? 255 : Math.round(value)
}

// In-place iterative radix-2 Cooley-Tukey FFT. re/im are Float64Array of the
// same power-of-two length; the result replaces them.
export function fft(re, im) {
  const n = re.length
  if (n !== im.length) throw new TypeError('re and im must have equal length')
  if (n === 0 || (n & (n - 1)) !== 0) throw new TypeError('fft length must be a power of two')
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr
      const ti = im[i]; im[i] = im[j]; im[j] = ti
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    const half = len >> 1
    for (let i = 0; i < n; i += len) {
      let curR = 1
      let curI = 0
      for (let k = 0; k < half; k++) {
        const aR = re[i + k]
        const aI = im[i + k]
        const bR = re[i + k + half] * curR - im[i + k + half] * curI
        const bI = re[i + k + half] * curI + im[i + k + half] * curR
        re[i + k] = aR + bR
        im[i + k] = aI + bI
        re[i + k + half] = aR - bR
        im[i + k + half] = aI - bI
        const nextR = curR * wr - curI * wi
        curI = curR * wi + curI * wr
        curR = nextR
      }
    }
  }
}

// Hann-windowed magnitude spectrum of `window` (Float32Array of samples in
// -1..1, oldest first), mapped to `bars` log-spaced bands over [minHz, maxHz].
// Each band is normalized by the spectral peak so the shape is visible; overall
// loudness is applied separately by the renderer's volume envelope.
export function barEnergies(window, {
  bars = DEFAULT_BARS,
  sampleRate = 24000,
  fftSize = DEFAULT_FFT_SIZE,
  minHz = DEFAULT_MIN_HZ,
  maxHz = DEFAULT_MAX_HZ,
} = {}) {
  if (!(window instanceof Float32Array)) throw new TypeError('window must be a Float32Array')
  const n = Math.min(fftSize, window.length)
  const re = new Float64Array(fftSize)
  const im = new Float64Array(fftSize)
  const start = window.length - n
  const denom = n > 1 ? n - 1 : 1
  for (let i = 0; i < n; i++) {
    const hann = 0.5 * (1 - Math.cos((2 * Math.PI * i) / denom))
    re[i] = (window[start + i] || 0) * hann
  }
  fft(re, im)

  const half = fftSize >> 1
  const nyquist = sampleRate / 2
  const mag = new Float64Array(half)
  let peak = 1e-9
  for (let k = 0; k < half; k++) {
    const m = Math.hypot(re[k], im[k]) / half
    mag[k] = m
    if (m > peak) peak = m
  }

  const binFor = hz => Math.max(0, Math.min(half - 1, Math.round((hz / nyquist) * half)))
  const minBin = Math.max(1, binFor(minHz))
  const maxBin = Math.max(minBin + 1, binFor(maxHz))
  const logMin = Math.log(minHz)
  const logSpan = Math.log(maxHz) - logMin
  const levels = new Float32Array(bars)
  for (let b = 0; b < bars; b++) {
    const f0 = Math.exp(logMin + logSpan * (b / bars))
    const f1 = Math.exp(logMin + logSpan * ((b + 1) / bars))
    const k0 = Math.max(minBin, binFor(f0))
    const k1 = Math.min(maxBin, Math.max(k0 + 1, binFor(f1)))
    let sum = 0
    let count = 0
    for (let k = k0; k < k1; k++) { sum += mag[k]; count++ }
    levels[b] = count ? Math.min(1, (sum / count) / peak) : 0
  }
  return levels
}

function hsvToRgb(h, s, v) {
  const i = Math.floor(h * 6)
  const f = h * 6 - i
  const p = v * (1 - s)
  const q = v * (1 - f * s)
  const t = v * (1 - (1 - f) * s)
  switch (((i % 6) + 6) % 6) {
    case 0: return [v, t, p]
    case 1: return [q, v, p]
    case 2: return [p, v, t]
    case 3: return [p, q, v]
    case 4: return [t, p, v]
    default: return [v, p, q]
  }
}

// Spectrum-analyzer hue: low bars warm, high bars cool. Returns BT.601 YCbCr.
function barColor(hue) {
  const [r, g, b] = hsvToRgb(0.02 + hue * 0.62, 0.85, 1).map(c => c * 255)
  return {
    y: clampByte(0.299 * r + 0.587 * g + 0.114 * b),
    u: clampByte(128 - 0.168736 * r - 0.331264 * g + 0.5 * b),
    v: clampByte(128 + 0.5 * r - 0.418688 * g - 0.081312 * b),
  }
}

// Draw `levels` (0..1 per bar) as vertical bars into a fresh I420 buffer of
// exactly width*height*1.5 bytes. Background is near-black with neutral chroma.
export function drawSpectrumI420({ width, height, levels }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0
    || width % 2 || height % 2) throw new TypeError('width and height must be positive even integers')
  if (!(levels instanceof Float32Array)) throw new TypeError('levels must be a Float32Array')
  const ySize = width * height
  const cSize = (width * height) / 4
  const data = Buffer.alloc(ySize + 2 * cSize)
  data.fill(16, 0, ySize)
  data.fill(128, ySize, ySize + cSize)
  data.fill(128, ySize + cSize, ySize + 2 * cSize)

  const bars = levels.length
  const cw = width / 2
  const margin = Math.max(2, Math.floor(height * 0.06))
  const usableH = height - margin
  const slot = width / bars
  const barW = Math.max(1, Math.floor(slot) - Math.max(1, Math.floor(slot * 0.25)))
  for (let b = 0; b < bars; b++) {
    const level = levels[b] < 0 ? 0 : levels[b] > 1 ? 1 : levels[b]
    const barH = Math.round(level * usableH)
    if (barH <= 0) continue
    const x0 = Math.floor(b * slot)
    const x1 = Math.min(width, x0 + barW)
    if (x1 <= x0) continue
    const yTop = height - margin - barH
    const { y, u, v } = barColor(b / Math.max(1, bars - 1))
    for (let row = yTop; row < height - margin; row++) {
      const off = row * width
      data.fill(y, off + x0, off + x1)
    }
    const cx0 = x0 >> 1
    const cx1 = Math.max(cx0 + 1, x1 >> 1)
    const cyTop = yTop >> 1
    const cyBot = (height - margin) >> 1
    for (let cy = cyTop; cy < cyBot; cy++) {
      data.fill(u, ySize + cy * cw + cx0, ySize + cy * cw + cx1)
      data.fill(v, ySize + cSize + cy * cw + cx0, ySize + cSize + cy * cw + cx1)
    }
  }
  return data
}

// Stateful per-session visualizer: a rolling FFT window fed with published PCM
// plus attack/release smoothing so bars rise fast and fall gradually.
export function createSpectrumRenderer({
  width,
  height,
  bars = DEFAULT_BARS,
  sampleRate = 24000,
  fftSize = DEFAULT_FFT_SIZE,
  minHz = DEFAULT_MIN_HZ,
  maxHz = DEFAULT_MAX_HZ,
  // RMS that maps to full-scale bar height. TTS speech sits well below 1.0, so
  // a modest reference keeps quiet passages visible without clipping loud ones.
  volumeReference = 0.12,
  attack = 0.55,
  release = 0.82,
} = {}) {
  const window = new Float32Array(fftSize)
  const prev = new Float32Array(bars)
  let filled = 0

  return {
    get bars() { return bars },
    // int16: Int16Array of newly published samples (PCM s16le, oldest first).
    push(int16) {
      const n = int16.length
      if (n === 0) return
      if (n >= fftSize) {
        for (let i = 0; i < fftSize; i++) window[i] = int16[n - fftSize + i] / 32768
        filled = fftSize
        return
      }
      window.copyWithin(0, n)
      for (let i = 0; i < n; i++) window[fftSize - n + i] = int16[i] / 32768
      filled = Math.min(fftSize, filled + n)
    },
    // Render the current window into an I420 frame.
    frame() {
      const raw = barEnergies(window, { bars, sampleRate, fftSize, minHz, maxHz })
      const count = Math.max(1, filled)
      let sum = 0
      for (let i = fftSize - count; i < fftSize; i++) sum += window[i] * window[i]
      const rms = Math.sqrt(sum / count)
      const volume = Math.min(1, rms / volumeReference)
      const levels = new Float32Array(bars)
      for (let b = 0; b < bars; b++) {
        const target = raw[b] * volume
        prev[b] = target > prev[b]
          ? attack * target + (1 - attack) * prev[b]
          : release * prev[b] + (1 - release) * target
        levels[b] = prev[b]
      }
      return drawSpectrumI420({ width, height, levels })
    },
  }
}
