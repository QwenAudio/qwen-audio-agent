// Screen capture and image loading for the backstage Agent's image tool.
//
// The Realtime frontstage cannot receive images at all: its session declares
// only text and audio modalities. Backstage ACP Agents do accept images, so
// looking at a screen or a picture belongs to the backstage path.
//
// Everything here uses tools that ship with macOS, so the feature adds no
// dependency: `screencapture` grabs the screen and `sips` scales the result
// down. Scaling matters more than it looks — a Retina screenshot is several
// megapixels, and sending it unscaled wastes a large part of the model's
// context on pixels it cannot use.
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { basename, extname, resolve } from 'node:path'
import { promisify } from 'node:util'

// execFile, never exec: every call below passes an argv array, so no shell
// parses the arguments and a path cannot inject anything. Paths are also run
// through resolve() first, which makes them absolute and therefore unable to
// be mistaken for a leading-dash option by screencapture, sips, or cp.
const run = promisify(execFile)

export const DEFAULT_MAX_DIMENSION = 1568
// Beyond this a screenshot is almost certainly not what the user meant, and
// the base64 payload would dominate the request.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const IMAGE_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
])

export function imageMimeType(path) {
  return IMAGE_TYPES.get(extname(String(path || '')).toLowerCase()) || null
}

export function screenCaptureSupported(platform = process.platform) {
  return platform === 'darwin'
}

function unsupported(platform) {
  return new Error(
    `当前平台（${platform}）不支持屏幕截图，该能力目前仅在 macOS 上可用。`,
  )
}

function captureDirectory(configDirectory) {
  const directory = resolve(configDirectory, 'screenshots')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  return directory
}

function stamp(now = new Date()) {
  return now.toISOString().replaceAll(/[:.]/g, '-').replace('Z', '')
}

// `sips -Z` scales the longest edge and keeps the aspect ratio. It rewrites the
// file in place, which is what we want: the caller only ever sees the scaled
// image, so an oversized original never reaches the model.
async function scaleDown(path, maxDimension, exec) {
  const limit = Number(maxDimension) > 0
    ? Math.floor(Number(maxDimension))
    : DEFAULT_MAX_DIMENSION
  await exec('sips', ['-Z', String(limit), path])
}

async function describe(path, mimeType) {
  const { size } = statSync(path)
  if (size > MAX_IMAGE_BYTES) {
    throw new Error(
      `图片过大（${Math.round(size / 1024)}KB），超过 ${
        MAX_IMAGE_BYTES / 1024 / 1024}MB 上限。`,
    )
  }
  return {
    base64: readFileSync(path).toString('base64'),
    mimeType,
    path,
    bytes: size,
  }
}

export async function captureScreen({
  configDirectory,
  maxDimension = DEFAULT_MAX_DIMENSION,
  platform = process.platform,
  exec = run,
} = {}) {
  if (!screenCaptureSupported(platform)) throw unsupported(platform)
  const path = resolve(
    captureDirectory(configDirectory),
    `screen-${stamp()}.png`,
  )
  // -x silences the shutter sound. In a voice product the sound would be
  // picked up by the microphone and fed back into the conversation.
  await exec('screencapture', ['-x', path])
  try {
    await scaleDown(path, maxDimension, exec)
    return await describe(path, 'image/png')
  } catch (error) {
    try {
      unlinkSync(path)
    } catch {
      // Leaving a stray file behind is not worth masking the real error.
    }
    throw error
  }
}

export async function loadImageFile(input, {
  configDirectory,
  maxDimension = DEFAULT_MAX_DIMENSION,
  exec = run,
} = {}) {
  const source = String(input || '').trim()
  if (!source) throw new Error('缺少图片路径。')
  const path = resolve(source.startsWith('~')
    ? source.replace(/^~/, process.env.HOME || '')
    : source)
  const mimeType = imageMimeType(path)
  if (!mimeType) {
    throw new Error(
      `不支持的图片类型：${basename(path)}（支持 ${
        [...IMAGE_TYPES.keys()].join('、')}）`,
    )
  }
  let stats = null
  try {
    stats = statSync(path)
  } catch {
    throw new Error(`找不到图片：${path}`)
  }
  if (!stats.isFile()) throw new Error(`不是文件：${path}`)
  // Copy before scaling: `sips -Z` rewrites in place, and silently shrinking a
  // file the user owns would be a surprising side effect of asking about it.
  const copy = resolve(
    captureDirectory(configDirectory),
    `image-${stamp()}${extname(path).toLowerCase()}`,
  )
  await exec('cp', [path, copy])
  try {
    await scaleDown(copy, maxDimension, exec)
    return { ...(await describe(copy, mimeType)), source: path }
  } catch (error) {
    try {
      unlinkSync(copy)
    } catch {
      // Same as above: the original error is the useful one.
    }
    throw error
  }
}
