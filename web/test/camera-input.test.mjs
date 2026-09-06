import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CAMERA_IMAGE_TOO_LARGE,
  OBSERVATION_MAX_BASE64_BYTES,
  appendRecentObservationFrame,
  blobToBase64,
  cameraFrameSize,
  captureCameraFrame,
  encodeCameraCanvas,
  stopCameraStream,
} from '../src/camera-input.js'

test('fits camera frames inside the 720p capture bounds', () => {
  assert.deepEqual(cameraFrameSize(1920, 1080), { width: 1280, height: 720 })
  assert.deepEqual(cameraFrameSize(1080, 1920), { width: 405, height: 720 })
  assert.deepEqual(cameraFrameSize(640, 480), { width: 640, height: 480 })
})

test('rejects camera frames without usable dimensions', () => {
  assert.throws(() => cameraFrameSize(0, 720), /camera_dimensions_unavailable/)
  assert.throws(() => cameraFrameSize(Number.NaN, 720), /camera_dimensions_unavailable/)
})

test('lowers JPEG quality until the camera image fits the byte limit', async () => {
  const qualities = []
  const canvas = {
    toBlob(callback, mime, quality) {
      qualities.push([mime, quality])
      callback({ size: Math.round(400_000 * quality) })
    },
  }
  const blob = await encodeCameraCanvas(canvas, {
    maxBytes: 200_000,
    qualities: [0.8, 0.4],
  })
  assert.equal(blob.size, 160_000)
  assert.deepEqual(qualities, [
    ['image/jpeg', 0.8],
    ['image/jpeg', 0.4],
  ])
})

test('rejects an image that cannot fit the camera byte limit', async () => {
  const canvas = {
    toBlob(callback) {
      callback({ size: 500_000 })
    },
  }
  await assert.rejects(
    encodeCameraCanvas(canvas, { maxBytes: 200_000, qualities: [0.8, 0.4] }),
    error => error.message === CAMERA_IMAGE_TOO_LARGE,
  )
})

test('draws the current video frame at the bounded size before encoding', async () => {
  const previousDocument = globalThis.document
  let canvas
  let drawn
  globalThis.document = {
    createElement(type) {
      assert.equal(type, 'canvas')
      canvas = {
        getContext: () => ({ drawImage: (...args) => { drawn = args } }),
        toBlob: callback => callback({ size: 100 }),
      }
      return canvas
    },
  }
  try {
    await captureCameraFrame(
      { videoWidth: 1920, videoHeight: 1080 },
      { maxBytes: 200, qualities: [0.8] },
    )
    assert.equal(canvas.width, 1280)
    assert.equal(canvas.height, 720)
    assert.deepEqual(drawn, [
      { videoWidth: 1920, videoHeight: 1080 },
      0,
      0,
      1280,
      720,
    ])
  } finally {
    globalThis.document = previousDocument
  }
})

test('stops every track when closing a camera stream', () => {
  const stopped = []
  stopCameraStream({
    getTracks: () => [
      { stop: () => stopped.push('video') },
      { stop: () => stopped.push('audio') },
    ],
  })
  assert.deepEqual(stopped, ['video', 'audio'])
})

test('keeps only the latest eight observation frames', () => {
  const frames = Array.from({ length: 8 }, (_, sequence) => ({ sequence }))
  const next = appendRecentObservationFrame(frames, { sequence: 8 })
  assert.equal(next.length, 8)
  assert.deepEqual(next.map(frame => frame.sequence), [1, 2, 3, 4, 5, 6, 7, 8])
})

test('converts a captured JPEG blob to its Base64 body', async () => {
  const previousReader = globalThis.FileReader
  class FakeFileReader {
    readAsDataURL(blob) {
      assert.equal(blob, 'blob')
      this.result = 'data:image/jpeg;base64,/9j/fake'
      this.onload?.()
    }
  }
  globalThis.FileReader = FakeFileReader
  try {
    assert.equal(await blobToBase64('blob'), '/9j/fake')
  } finally {
    globalThis.FileReader = previousReader
  }
})

test('rejects a Base64 observation body above the provider limit', async () => {
  const previousReader = globalThis.FileReader
  class FakeFileReader {
    readAsDataURL() {
      this.result = `data:image/jpeg;base64,${'a'.repeat(OBSERVATION_MAX_BASE64_BYTES + 1)}`
      this.onload?.()
    }
  }
  globalThis.FileReader = FakeFileReader
  try {
    await assert.rejects(blobToBase64('blob'), error => (
      error.message === CAMERA_IMAGE_TOO_LARGE
    ))
  } finally {
    globalThis.FileReader = previousReader
  }
})
