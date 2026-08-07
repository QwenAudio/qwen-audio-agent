// 桌面版皮肤存储与导入：Codex pet 包格式（pet.json + spritesheet.webp）。
// 纯 Node 模块，不依赖 Electron，zip 解压通过注入的系统工具执行。

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  isBuiltinOrbSkin,
  ORB_SKIN_ID_PATTERN,
} from '../../shared/orb-skin-catalog.mjs'

const execFileAsync = promisify(execFile)

const MAX_SPRITESHEET_BYTES = 8 * 1024 * 1024
// 与 Codex App 的 MAX_PET_FRAMES 对齐。
const MAX_PET_FRAMES = 256
const MAX_ANIMATION_FPS = 60
const DEFAULT_FRAME_SPEC = Object.freeze({
  width: 192,
  height: 208,
  columns: 8,
  rows: 9,
})
const V2_DEFAULT_ROWS = 11
// 渲染端默认轨道名，自定义 animations 的 fallback 必须落在
// 自定义名或这张表内。
export const DEFAULT_ANIMATION_NAMES = Object.freeze([
  'idle',
  'running-right',
  'running-left',
  'waving',
  'jumping',
  'failed',
  'waiting',
  'running',
  'review',
  'working',
  'attention',
])

export function skinsDirectory(configDirectory) {
  return join(configDirectory, 'skins')
}

function readUInt24LE(buffer, offset) {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16)
}

// 最小 WebP 头解析，覆盖 VP8X（扩展）、VP8（有损）、VP8L（无损）三种布局。
export function webpDimensions(buffer) {
  if (
    buffer.length < 30
    || buffer.toString('latin1', 0, 4) !== 'RIFF'
    || buffer.toString('latin1', 8, 12) !== 'WEBP'
  ) {
    return null
  }
  const chunk = buffer.toString('latin1', 12, 16)
  if (chunk === 'VP8X') {
    return {
      width: 1 + readUInt24LE(buffer, 24),
      height: 1 + readUInt24LE(buffer, 27),
    }
  }
  if (chunk === 'VP8 ') {
    if (buffer[23] !== 0x9d || buffer[24] !== 0x01 || buffer[25] !== 0x2a) {
      return null
    }
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    }
  }
  if (chunk === 'VP8L') {
    if (buffer[20] !== 0x2f) return null
    const bits = buffer.readUInt32LE(21)
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    }
  }
  return null
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0
}

function frameSpec(manifest) {
  const version = manifest.spriteVersionNumber ?? 1
  const fallbackRows = version === 2 ? V2_DEFAULT_ROWS : DEFAULT_FRAME_SPEC.rows
  const spec = manifest.frame && typeof manifest.frame === 'object'
    ? manifest.frame
    : {
        ...DEFAULT_FRAME_SPEC,
        rows: fallbackRows,
      }
  for (const key of ['width', 'height', 'columns', 'rows']) {
    if (!positiveInteger(spec[key])) {
      throw new Error(`皮肤包 frame.${key} 必须是正整数`)
    }
  }
  return {
    width: spec.width,
    height: spec.height,
    columns: spec.columns,
    rows: spec.rows,
  }
}

function validateAnimations(manifest, frameCount) {
  const specs = manifest.animations
  if (specs === undefined) return undefined
  if (!specs || typeof specs !== 'object' || Array.isArray(specs)) {
    throw new Error('皮肤包 animations 必须是对象')
  }
  const names = new Set([
    ...DEFAULT_ANIMATION_NAMES,
    ...Object.keys(specs),
  ])
  for (const [name, spec] of Object.entries(specs)) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      throw new Error(`皮肤包动画 ${name} 定义必须是对象`)
    }
    if (!Array.isArray(spec.frames) || spec.frames.length === 0) {
      throw new Error(`皮肤包动画 ${name} 至少要包含一帧`)
    }
    for (const index of spec.frames) {
      if (!Number.isInteger(index) || index < 0 || index >= frameCount) {
        throw new Error(`皮肤包动画 ${name} 引用了越界的帧索引 ${index}`)
      }
    }
    if (spec.fps !== undefined) {
      if (
        typeof spec.fps !== 'number'
        || !Number.isFinite(spec.fps)
        || spec.fps <= 0
        || spec.fps > MAX_ANIMATION_FPS
      ) {
        throw new Error(
          `皮肤包动画 ${name} 的 fps 必须在 0 到 ${MAX_ANIMATION_FPS} 之间`,
        )
      }
    }
    if (spec.fallback !== undefined && spec.fallback !== '') {
      if (!names.has(spec.fallback)) {
        throw new Error(`皮肤包动画 ${name} 的 fallback ${spec.fallback} 不存在`)
      }
    }
  }
  return specs
}

export function validateSkinPackage(dir) {
  const manifestPath = join(dir, 'pet.json')
  if (!existsSync(manifestPath)) {
    throw new Error('皮肤包缺少 pet.json')
  }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    throw new Error('皮肤包 pet.json 不是有效的 JSON')
  }
  const id = String(manifest.id || '').trim()
  if (!ORB_SKIN_ID_PATTERN.test(id)) {
    throw new Error('皮肤包 pet.json 缺少合法的 id')
  }
  const spritesheetRelative = String(
    manifest.spritesheetPath || 'spritesheet.webp',
  ).trim()
  const spritesheetPath = resolve(dir, spritesheetRelative)
  const pathFromDir = relative(resolve(dir), spritesheetPath)
  if (pathFromDir.startsWith('..') || pathFromDir.includes('\0')) {
    throw new Error('皮肤包 spritesheetPath 不能指向包目录之外')
  }
  if (!existsSync(spritesheetPath) || !statSync(spritesheetPath).isFile()) {
    throw new Error(`皮肤包缺少贴图文件 ${spritesheetRelative}`)
  }
  if (statSync(spritesheetPath).size > MAX_SPRITESHEET_BYTES) {
    throw new Error('皮肤包贴图超过 8MB 上限')
  }
  const frame = frameSpec(manifest)
  const frameCount = frame.columns * frame.rows
  if (frameCount > MAX_PET_FRAMES) {
    throw new Error(`皮肤包总帧数不能超过 ${MAX_PET_FRAMES}`)
  }
  const dimensions = webpDimensions(readFileSync(spritesheetPath))
  if (!dimensions) {
    throw new Error('皮肤包贴图不是有效的 WebP 文件')
  }
  const expectedWidth = frame.columns * frame.width
  const expectedHeight = frame.rows * frame.height
  if (
    dimensions.width !== expectedWidth
    || dimensions.height !== expectedHeight
  ) {
    throw new Error(
      `皮肤包贴图尺寸应为 ${expectedWidth}x${expectedHeight}，`
      + `实际是 ${dimensions.width}x${dimensions.height}`,
    )
  }
  return {
    id,
    displayName: String(manifest.displayName || id).trim() || id,
    spriteVersionNumber: manifest.spriteVersionNumber ?? 1,
    spritesheetPath: spritesheetRelative,
    frame,
    animations: validateAnimations(manifest, frameCount),
  }
}

export async function extractZipArchive(zipPath, destination) {
  mkdirSync(destination, { recursive: true })
  if (process.platform === 'darwin') {
    await execFileAsync('ditto', ['-x', '-k', zipPath, destination])
    return
  }
  if (process.platform === 'win32') {
    await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Expand-Archive -LiteralPath $env:QWEN_AUDIO_SKIN_ZIP '
      + '-DestinationPath $env:QWEN_AUDIO_SKIN_DEST -Force',
    ], {
      env: {
        ...process.env,
        QWEN_AUDIO_SKIN_ZIP: zipPath,
        QWEN_AUDIO_SKIN_DEST: destination,
      },
    })
    return
  }
  await execFileAsync('unzip', ['-o', '-q', zipPath, '-d', destination])
}

function locateSkinRoot(extractedDir) {
  if (existsSync(join(extractedDir, 'pet.json'))) return extractedDir
  const entries = readdirSync(extractedDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
  if (
    entries.length === 1
    && existsSync(join(extractedDir, entries[0].name, 'pet.json'))
  ) {
    return join(extractedDir, entries[0].name)
  }
  throw new Error('压缩包内没有找到 pet.json')
}

function stageSkin(sourceDir, info, skinsRoot) {
  const staging = join(
    skinsRoot,
    `.install-${randomBytes(6).toString('hex')}`,
  )
  try {
    mkdirSync(join(staging, dirname(info.spritesheetPath)), {
      recursive: true,
    })
    cpSync(join(sourceDir, 'pet.json'), join(staging, 'pet.json'))
    cpSync(
      resolve(sourceDir, info.spritesheetPath),
      join(staging, info.spritesheetPath),
    )
    const target = join(skinsRoot, info.id)
    rmSync(target, { recursive: true, force: true })
    renameSync(staging, target)
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    throw error
  }
}

export async function importSkin({
  source,
  skinsRoot,
  extractZip = extractZipArchive,
}) {
  const sourcePath = resolve(String(source || ''))
  if (!existsSync(sourcePath)) {
    throw new Error('皮肤路径不存在')
  }
  mkdirSync(skinsRoot, { recursive: true })
  let packageDir = ''
  let temporaryDir = ''
  if (statSync(sourcePath).isDirectory()) {
    packageDir = sourcePath
  } else if (basename(sourcePath) === 'pet.json') {
    packageDir = dirname(sourcePath)
  } else if (sourcePath.toLowerCase().endsWith('.zip')) {
    temporaryDir = join(
      skinsRoot,
      `.import-${randomBytes(6).toString('hex')}`,
    )
    await extractZip(sourcePath, temporaryDir)
    packageDir = locateSkinRoot(temporaryDir)
  } else {
    throw new Error('请选择皮肤文件夹、pet.json 或 zip 压缩包')
  }
  try {
    const info = validateSkinPackage(packageDir)
    if (isBuiltinOrbSkin(info.id)) {
      throw new Error(`皮肤 id ${info.id} 是内置皮肤保留名`)
    }
    stageSkin(packageDir, info, skinsRoot)
    return { id: info.id, displayName: info.displayName }
  } finally {
    if (temporaryDir) rmSync(temporaryDir, { recursive: true, force: true })
  }
}

export function removeSkin({ id, skinsRoot }) {
  const skinId = String(id || '').trim()
  // id 模式校验同时排除了路径分隔符，join 不会逃出 skins 目录。
  if (!ORB_SKIN_ID_PATTERN.test(skinId)) {
    throw new Error('皮肤 id 不合法')
  }
  if (isBuiltinOrbSkin(skinId)) {
    throw new Error('内置外观不能删除')
  }
  const target = join(skinsRoot, skinId)
  if (!existsSync(target)) return false
  rmSync(target, { recursive: true, force: true })
  return true
}

export function listSkins(skinsRoot) {
  let entries
  try {
    entries = readdirSync(skinsRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const skins = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    try {
      const info = validateSkinPackage(join(skinsRoot, entry.name))
      // 目录名必须与 pet.json id 一致，URL 路由按目录名寻址。
      if (info.id !== entry.name) continue
      skins.push({
        id: info.id,
        type: 'sprite',
        displayName: info.displayName,
      })
    } catch {
      // 坏包跳过，不影响其他皮肤。
    }
  }
  return skins.sort((a, b) => a.id.localeCompare(b.id))
}
