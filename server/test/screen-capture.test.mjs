import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  DEFAULT_MAX_DIMENSION,
  captureScreen,
  imageMimeType,
  loadImageFile,
  screenCaptureSupported,
} from '../src/agent/screen-capture.mjs'

function workspace() {
  return mkdtempSync(resolve(tmpdir(), 'qwaudio-image-'))
}

// Records the argv arrays instead of running anything, so the tests assert on
// the exact commands without touching the screen or the shell.
function recorder(onCall) {
  const calls = []
  return {
    calls,
    exec: async (file, args) => {
      calls.push({ file, args })
      onCall?.(file, args)
      return { stdout: '', stderr: '' }
    },
  }
}

test('maps only supported image extensions', () => {
  assert.equal(imageMimeType('a.png'), 'image/png')
  assert.equal(imageMimeType('a.JPG'), 'image/jpeg')
  assert.equal(imageMimeType('a.jpeg'), 'image/jpeg')
  assert.equal(imageMimeType('a.webp'), 'image/webp')
  assert.equal(imageMimeType('a.pdf'), null)
  assert.equal(imageMimeType('a.txt'), null)
  assert.equal(imageMimeType(''), null)
})

test('screen capture is macOS only and says so', async () => {
  assert.equal(screenCaptureSupported('darwin'), true)
  assert.equal(screenCaptureSupported('linux'), false)
  assert.equal(screenCaptureSupported('win32'), false)
  const configDirectory = workspace()
  await assert.rejects(
    captureScreen({ configDirectory, platform: 'linux' }),
    /仅在 macOS/,
  )
  // Nothing should be created on an unsupported platform.
  assert.equal(existsSync(resolve(configDirectory, 'screenshots')), false)
})

test('capture writes into the config directory and scales the result', async () => {
  const configDirectory = workspace()
  const { calls, exec } = recorder((file, args) => {
    // Stand in for screencapture writing the file the scaler then reads.
    if (file === 'screencapture') writeFileSync(args.at(-1), 'png-bytes')
  })
  const image = await captureScreen({
    configDirectory,
    platform: 'darwin',
    exec,
  })

  const [capture, scale] = calls
  assert.equal(capture.file, 'screencapture')
  // -x keeps the shutter sound out of the microphone.
  assert.ok(capture.args.includes('-x'))
  assert.equal(scale.file, 'sips')
  assert.deepEqual(scale.args.slice(0, 2), ['-Z', String(DEFAULT_MAX_DIMENSION)])

  assert.equal(image.mimeType, 'image/png')
  assert.equal(Buffer.from(image.base64, 'base64').toString(), 'png-bytes')
  assert.ok(image.path.startsWith(resolve(configDirectory, 'screenshots')))
  assert.equal(image.bytes, 'png-bytes'.length)
})

test('capture honours a custom max dimension', async () => {
  const configDirectory = workspace()
  const { calls, exec } = recorder((file, args) => {
    if (file === 'screencapture') writeFileSync(args.at(-1), 'x')
  })
  await captureScreen({
    configDirectory,
    platform: 'darwin',
    maxDimension: 800,
    exec,
  })
  assert.deepEqual(calls[1].args.slice(0, 2), ['-Z', '800'])
})

test('rejects an unsupported or missing image file before copying it', async () => {
  const configDirectory = workspace()
  const source = workspace()
  const notes = resolve(source, 'notes.txt')
  writeFileSync(notes, 'not an image')
  const { calls, exec } = recorder()

  await assert.rejects(
    loadImageFile(notes, { configDirectory, exec }),
    /不支持的图片类型/,
  )
  await assert.rejects(
    loadImageFile(resolve(source, 'missing.png'), { configDirectory, exec }),
    /找不到图片/,
  )
  await assert.rejects(loadImageFile('', { configDirectory, exec }), /缺少图片路径/)
  // A directory that looks like an image by name still must not be read.
  const directory = resolve(source, 'album.png')
  mkdirSync(directory, { recursive: true })
  await assert.rejects(
    loadImageFile(directory, { configDirectory, exec }),
    /不是文件/,
  )
  assert.equal(calls.length, 0, 'nothing should run for a rejected input')
})

test('loading an image copies it before scaling so the original is untouched', async () => {
  const configDirectory = workspace()
  const source = workspace()
  const picture = resolve(source, 'shot.png')
  writeFileSync(picture, 'original-bytes')
  const { calls, exec } = recorder((file, args) => {
    if (file === 'cp') writeFileSync(args[1], 'original-bytes')
  })

  const image = await loadImageFile(picture, { configDirectory, exec })

  const [copy, scale] = calls
  assert.equal(copy.file, 'cp')
  assert.equal(copy.args[0], picture)
  assert.ok(copy.args[1].startsWith(resolve(configDirectory, 'screenshots')))
  assert.equal(scale.file, 'sips')
  // sips rewrites in place, so it must run on the copy, never the original.
  assert.equal(scale.args.at(-1), copy.args[1])

  assert.equal(image.source, picture)
  assert.notEqual(image.path, picture)
  assert.equal(image.mimeType, 'image/png')
  assert.equal(Buffer.from(image.base64, 'base64').toString(), 'original-bytes')
})

test('expands a leading tilde in an image path', async () => {
  const configDirectory = workspace()
  const home = workspace()
  mkdirSync(resolve(home, 'Pictures'), { recursive: true })
  const picture = resolve(home, 'Pictures/x.png')
  writeFileSync(picture, 'bytes')
  const previousHome = process.env.HOME
  process.env.HOME = home
  try {
    const { calls, exec } = recorder((file, args) => {
      if (file === 'cp') writeFileSync(args[1], 'bytes')
    })
    const image = await loadImageFile('~/Pictures/x.png', {
      configDirectory,
      exec,
    })
    assert.equal(calls[0].args[0], picture)
    assert.equal(image.source, picture)
  } finally {
    process.env.HOME = previousHome
  }
})

test('rejects an image that is too large to send', async () => {
  const configDirectory = workspace()
  const source = workspace()
  const picture = resolve(source, 'huge.png')
  writeFileSync(picture, 'seed')
  const { exec } = recorder((file, args) => {
    // Simulate a scaler that could not bring the file under the limit.
    if (file === 'cp') writeFileSync(args[1], Buffer.alloc(9 * 1024 * 1024, 1))
  })
  await assert.rejects(
    loadImageFile(picture, { configDirectory, exec }),
    /图片过大/,
  )
})
