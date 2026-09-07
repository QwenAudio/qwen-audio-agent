import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CAMERA_IMAGE_TOO_LARGE,
  blobToBase64,
  cameraFrameSize,
  encodeCameraCanvas,
  stopCameraStream,
} from '../src/composer/camera-input.js'

test('sizes camera frames within the realtime visual limits', () => {
  assert.deepEqual(cameraFrameSize(1920, 1080), { width: 1280, height: 720 })
  assert.deepEqual(cameraFrameSize(640, 480), { width: 640, height: 480 })
  assert.throws(() => cameraFrameSize(0, 480), /camera_dimensions_unavailable/)
})

test('stops every camera track', () => {
  const stopped = []
  stopCameraStream({
    getTracks: () => [
      { stop: () => stopped.push('video') },
      { stop: () => stopped.push('aux') },
    ],
  })
  assert.deepEqual(stopped, ['video', 'aux'])
})

test('reduces JPEG quality until the encoded frame fits', async () => {
  const attempts = []
  const canvas = {
    toBlob(callback, type, quality) {
      attempts.push({ type, quality })
      callback({ size: attempts.length === 1 ? 300 : 100 })
    },
  }
  const blob = await encodeCameraCanvas(canvas, {
    maxBytes: 200,
    qualities: [0.8, 0.4],
  })
  assert.equal(blob.size, 100)
  assert.deepEqual(attempts, [
    { type: 'image/jpeg', quality: 0.8 },
    { type: 'image/jpeg', quality: 0.4 },
  ])
})

test('rejects a frame that cannot fit at the lowest quality', async () => {
  const canvas = {
    toBlob(callback) {
      callback({ size: 300 })
    },
  }
  await assert.rejects(
    encodeCameraCanvas(canvas, { maxBytes: 200, qualities: [0.5] }),
    error => error.message === CAMERA_IMAGE_TOO_LARGE,
  )
})

test('extracts the Base64 body from a browser data URL', async t => {
  const OriginalFileReader = globalThis.FileReader
  t.after(() => {
    globalThis.FileReader = OriginalFileReader
  })
  globalThis.FileReader = class {
    readAsDataURL() {
      this.result = 'data:image/jpeg;base64,/9j/2Q=='
      this.onload()
    }
  }
  assert.equal(await blobToBase64({ size: 4 }), '/9j/2Q==')
})
