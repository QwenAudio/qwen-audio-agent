export const CAMERA_MAX_WIDTH = 1280
export const CAMERA_MAX_HEIGHT = 720
export const CAMERA_MAX_BYTES = 256 * 1024
export const CAMERA_IMAGE_TOO_LARGE = 'camera_image_too_large'

export const CAMERA_JPEG_QUALITIES = Object.freeze([
  0.86,
  0.74,
  0.62,
  0.5,
  0.38,
  0.25,
  0.18,
  0.12,
  0.08,
])

export function cameraFrameSize(
  width,
  height,
  { maxWidth = CAMERA_MAX_WIDTH, maxHeight = CAMERA_MAX_HEIGHT } = {},
) {
  const sourceWidth = Number(width)
  const sourceHeight = Number(height)
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight)
    || sourceWidth <= 0 || sourceHeight <= 0) {
    throw new Error('camera_dimensions_unavailable')
  }
  const scale = Math.min(1, maxWidth / sourceWidth, maxHeight / sourceHeight)
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  }
}

export function stopCameraStream(stream) {
  stream?.getTracks?.().forEach(track => track.stop())
}

export function encodeCameraCanvas(
  canvas,
  {
    maxBytes = CAMERA_MAX_BYTES,
    qualities = CAMERA_JPEG_QUALITIES,
  } = {},
) {
  if (!canvas || typeof canvas.toBlob !== 'function') {
    return Promise.reject(new Error('camera_encoder_unavailable'))
  }
  const candidates = [...qualities].filter(value => Number.isFinite(value))
  if (!candidates.length) {
    return Promise.reject(new Error('camera_encoder_unavailable'))
  }
  return new Promise((resolve, reject) => {
    let index = 0
    const encode = () => {
      canvas.toBlob(blob => {
        if (blob && blob.size <= maxBytes) {
          resolve(blob)
          return
        }
        if (index + 1 >= candidates.length) {
          reject(new Error(
            blob ? CAMERA_IMAGE_TOO_LARGE : 'camera_encoder_unavailable',
          ))
          return
        }
        index += 1
        encode()
      }, 'image/jpeg', candidates[index])
    }
    encode()
  })
}

export async function captureCameraFrame(video, options = {}) {
  const dimensions = cameraFrameSize(video?.videoWidth, video?.videoHeight, options)
  const canvas = document.createElement('canvas')
  canvas.width = dimensions.width
  canvas.height = dimensions.height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('camera_encoder_unavailable')
  context.drawImage(video, 0, 0, dimensions.width, dimensions.height)
  return encodeCameraCanvas(canvas, options)
}
