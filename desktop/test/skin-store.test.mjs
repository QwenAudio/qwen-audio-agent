import assert from 'node:assert/strict'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  importSkin,
  listSkins,
  removeSkin,
  skinsDirectory,
  validateSkinPackage,
  webpDimensions,
} from '../src/skin-store.mjs'

function makeWebp(width, height) {
  // 最小 VP8X 头：RIFF + WEBP + VP8X chunk（宽高按 minus-one 24 位小端）。
  const buffer = Buffer.alloc(30)
  buffer.write('RIFF', 0, 'latin1')
  buffer.writeUInt32LE(22, 4)
  buffer.write('WEBP', 8, 'latin1')
  buffer.write('VP8X', 12, 'latin1')
  buffer.writeUInt32LE(10, 16)
  buffer.writeUIntLE(width - 1, 24, 3)
  buffer.writeUIntLE(height - 1, 27, 3)
  return buffer
}

function writeSkin(dir, {
  id = 'firefly--lingxiaotian',
  manifest = {},
  width = 1536,
  height = 1872,
  spritesheet = 'spritesheet.webp',
} = {}) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'pet.json'), JSON.stringify({
    id,
    displayName: 'Firefly',
    spritesheetPath: spritesheet,
    ...manifest,
  }))
  writeFileSync(join(dir, spritesheet), makeWebp(width, height))
}

function temporaryRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'qwen-audio-skins-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

test('parses WebP dimensions from VP8X, VP8, and VP8L headers', () => {
  assert.deepEqual(
    webpDimensions(makeWebp(1536, 1872)),
    { width: 1536, height: 1872 },
  )

  const lossy = Buffer.alloc(30)
  lossy.write('RIFF', 0, 'latin1')
  lossy.write('WEBP', 8, 'latin1')
  lossy.write('VP8 ', 12, 'latin1')
  lossy[23] = 0x9d
  lossy[24] = 0x01
  lossy[25] = 0x2a
  lossy.writeUInt16LE(1536, 26)
  lossy.writeUInt16LE(2288, 28)
  assert.deepEqual(webpDimensions(lossy), { width: 1536, height: 2288 })

  const lossless = Buffer.alloc(30)
  lossless.write('RIFF', 0, 'latin1')
  lossless.write('WEBP', 8, 'latin1')
  lossless.write('VP8L', 12, 'latin1')
  lossless[20] = 0x2f
  lossless.writeUInt32LE((1535 & 0x3fff) | ((1871 & 0x3fff) << 14), 21)
  assert.deepEqual(webpDimensions(lossless), { width: 1536, height: 1872 })

  assert.equal(webpDimensions(Buffer.from('not a webp file at all')), null)
})

test('validates Codex pet packages against the grid contract', t => {
  const root = temporaryRoot(t)

  const v1 = join(root, 'v1')
  writeSkin(v1)
  assert.deepEqual(validateSkinPackage(v1), {
    id: 'firefly--lingxiaotian',
    displayName: 'Firefly',
    spriteVersionNumber: 1,
    spritesheetPath: 'spritesheet.webp',
    frame: { width: 192, height: 208, columns: 8, rows: 9 },
    animations: undefined,
  })

  // v2 缺省 11 行网格。
  const v2 = join(root, 'v2')
  writeSkin(v2, { manifest: { spriteVersionNumber: 2 }, height: 2288 })
  assert.equal(validateSkinPackage(v2).frame.rows, 11)

  // 自定义 frame spec 决定期望尺寸。
  const custom = join(root, 'custom')
  writeSkin(custom, {
    manifest: { frame: { width: 64, height: 64, columns: 4, rows: 2 } },
    width: 256,
    height: 128,
  })
  assert.equal(validateSkinPackage(custom).frame.columns, 4)

  // 尺寸与网格不符被拒绝。
  const wrong = join(root, 'wrong')
  writeSkin(wrong, { width: 1536, height: 1000 })
  assert.throws(() => validateSkinPackage(wrong), /贴图尺寸应为 1536x1872/)

  // 缺 pet.json、非法 id、贴图路径穿越。
  const empty = join(root, 'empty')
  mkdirSync(empty)
  assert.throws(() => validateSkinPackage(empty), /缺少 pet\.json/)

  const badId = join(root, 'bad-id')
  writeSkin(badId, { id: '../escape' })
  assert.throws(() => validateSkinPackage(badId), /缺少合法的 id/)

  const traversal = join(root, 'traversal')
  writeSkin(traversal)
  writeFileSync(join(traversal, 'pet.json'), JSON.stringify({
    id: 'traversal',
    spritesheetPath: '../v1/spritesheet.webp',
  }))
  assert.throws(() => validateSkinPackage(traversal), /包目录之外/)
})

test('validates optional custom animation tracks', t => {
  const root = temporaryRoot(t)

  const good = join(root, 'good')
  writeSkin(good, {
    manifest: {
      animations: {
        'spin': { frames: [0, 1, 2], fps: 12, fallback: 'idle' },
      },
    },
  })
  assert.deepEqual(validateSkinPackage(good).animations.spin.frames, [0, 1, 2])

  const badFps = join(root, 'bad-fps')
  writeSkin(badFps, {
    manifest: { animations: { 'spin': { frames: [0], fps: 120 } } },
  })
  assert.throws(() => validateSkinPackage(badFps), /fps 必须在 0 到 60/)

  const badIndex = join(root, 'bad-index')
  writeSkin(badIndex, {
    manifest: { animations: { 'spin': { frames: [999] } } },
  })
  assert.throws(() => validateSkinPackage(badIndex), /越界的帧索引/)

  const badFallback = join(root, 'bad-fallback')
  writeSkin(badFallback, {
    manifest: { animations: { 'spin': { frames: [0], fallback: 'nope' } } },
  })
  assert.throws(() => validateSkinPackage(badFallback), /fallback nope 不存在/)
})

test('imports skins from directories, pet.json paths, and zip archives', async t => {
  const root = temporaryRoot(t)
  const skinsRoot = skinsDirectory(join(root, 'config'))

  // 目录导入。
  const source = join(root, 'source')
  writeSkin(source)
  assert.deepEqual(await importSkin({ source, skinsRoot }), {
    id: 'firefly--lingxiaotian',
    displayName: 'Firefly',
  })
  assert.deepEqual(listSkins(skinsRoot), [{
    id: 'firefly--lingxiaotian',
    type: 'sprite',
    displayName: 'Firefly',
  }])

  // pet.json 路径导入（Windows 文件对话框兜底），同 id 覆盖。
  const updated = join(root, 'updated')
  writeSkin(updated, { manifest: { displayName: '流萤' } })
  await importSkin({ source: join(updated, 'pet.json'), skinsRoot })
  assert.equal(listSkins(skinsRoot)[0].displayName, '流萤')

  // zip 导入走注入的解压器，皮肤位于压缩包唯一子目录。
  const zipContent = join(root, 'zip-content', 'acheron--lingxiaotian')
  writeSkin(zipContent, { id: 'acheron--lingxiaotian' })
  writeFileSync(join(root, 'skin.zip'), 'placeholder zip bytes')
  const imported = await importSkin({
    source: join(root, 'skin.zip'),
    skinsRoot,
    extractZip: async (zipPath, destination) => {
      assert.equal(zipPath, join(root, 'skin.zip'))
      cpSync(join(root, 'zip-content'), destination, { recursive: true })
    },
  })
  assert.equal(imported.id, 'acheron--lingxiaotian')
  assert.deepEqual(
    listSkins(skinsRoot).map(skin => skin.id),
    ['acheron--lingxiaotian', 'firefly--lingxiaotian'],
  )
  // 导入的临时目录已清理。
  assert.deepEqual(
    readdirSync(skinsRoot).filter(name => name.startsWith('.')),
    [],
  )
})

test('rejects builtin ids and unsupported sources', async t => {
  const root = temporaryRoot(t)
  const skinsRoot = join(root, 'skins')

  const reserved = join(root, 'reserved')
  writeSkin(reserved, { id: 'fluid' })
  await assert.rejects(
    importSkin({ source: reserved, skinsRoot }),
    /内置皮肤保留名/,
  )

  writeFileSync(join(root, 'skin.rar'), 'not supported')
  await assert.rejects(
    importSkin({ source: join(root, 'skin.rar'), skinsRoot }),
    /请选择皮肤文件夹/,
  )
  await assert.rejects(
    importSkin({ source: join(root, 'missing'), skinsRoot }),
    /皮肤路径不存在/,
  )
})

test('removes imported skins but never builtin appearances', t => {
  const root = temporaryRoot(t)
  const skinsRoot = join(root, 'skins')

  writeSkin(join(skinsRoot, 'firefly--lingxiaotian'))
  assert.equal(removeSkin({ id: 'firefly--lingxiaotian', skinsRoot }), true)
  assert.deepEqual(listSkins(skinsRoot), [])
  // 重复删除是 no-op。
  assert.equal(removeSkin({ id: 'firefly--lingxiaotian', skinsRoot }), false)

  assert.throws(() => removeSkin({ id: 'fluid', skinsRoot }), /内置外观/)
  assert.throws(() => removeSkin({ id: '../escape', skinsRoot }), /不合法/)
  assert.throws(() => removeSkin({ id: '', skinsRoot }), /不合法/)
})

test('listSkins skips broken packages and mismatched directory names', t => {
  const root = temporaryRoot(t)
  const skinsRoot = join(root, 'skins')

  writeSkin(join(skinsRoot, 'firefly--lingxiaotian'))
  // 坏包：贴图缺失。
  mkdirSync(join(skinsRoot, 'broken'), { recursive: true })
  writeFileSync(join(skinsRoot, 'broken', 'pet.json'), JSON.stringify({
    id: 'broken',
    spritesheetPath: 'missing.webp',
  }))
  // 目录名与 pet.json id 不一致：跳过（URL 按目录名寻址）。
  writeSkin(join(skinsRoot, 'renamed'), { id: 'other-id' })
  // 隐藏目录忽略。
  writeSkin(join(skinsRoot, '.staging'))

  assert.deepEqual(listSkins(skinsRoot).map(skin => skin.id), [
    'firefly--lingxiaotian',
  ])
  assert.deepEqual(listSkins(join(root, 'missing')), [])
})
