export const CAPTURE_ACTION = 'xomni.visual.capture'
export const CAPTURE_CAPABILITY = `client.actions.${CAPTURE_ACTION}`
export const MAX_IMAGE_BYTES = 190 * 1024

export function validateFrame(frame, now = Date.now()) {
  if (!frame || !['camera', 'screen', 'image'].includes(frame.source)
    || !Number.isFinite(frame.capturedAt) || Math.abs(now - frame.capturedAt) > 15_000
    || typeof frame.generation !== 'string' || frame.generation.length > 80) {
    throw new Error('Visual source is unavailable or the captured frame is stale')
  }
  const image = String(frame.image || '')
  if (image.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(image)) throw new Error('Invalid visual frame')
  const bytes = Buffer.from(image, 'base64')
  if (bytes.length < 4 || bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== image
    || bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) {
    throw new Error('Visual capture must be a bounded JPEG')
  }
  return { image, source: frame.source, capturedAt: frame.capturedAt, generation: frame.generation }
}

export async function captureFrame(context, { signal = context.signal } = {}) {
  if (!context.supportsClientAction?.(CAPTURE_ACTION)) throw new Error('This client cannot capture visual input')
  const result = await context.requestClientAction(CAPTURE_ACTION, {}, { signal, timeoutMs: 8_000 })
  return validateFrame(result.output)
}
