import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CAMERA_IMAGE_TOO_LARGE,
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
        getContext: () => ({
          drawImage: (...args) => { drawn = args },
        }),
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
