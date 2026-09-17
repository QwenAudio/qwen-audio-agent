import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  filePartFromPath,
  inputPartsFromText,
  pastedPathReferences,
} from '../src/input-parts.mjs'

test('creates OpenCode-style inline file parts from TUI paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qaa-tui-input-'))
  const path = join(directory, 'SKILL.md')
  await writeFile(path, '# Skill')
  const part = await filePartFromPath(path)
  assert.equal(part.type, 'file')
  assert.equal(part.mime, 'text/markdown')
  assert.match(part.url, /^data:text\/markdown;base64,/)
})

test('expands @path references into file parts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qaa-tui-input-'))
  const path = join(directory, 'sample.txt')
  await writeFile(path, 'hello')
  const parts = await inputPartsFromText(`分析 @${path}`)
  assert.equal(parts[0].type, 'text')
  assert.equal(parts[1].filename, 'sample.txt')
  assert.equal(parts[1].source.text.value, `@${path}`)
  assert.equal(parts[1].source.text.start, 3)
})

test('promotes a directly pasted local path into an attachment', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qaa-tui-input-'))
  const path = join(directory, 'pasted image.png')
  await writeFile(path, 'image')

  const parts = await inputPartsFromText(path.replaceAll(' ', '\\ '))

  assert.equal(parts[0].text, '[Image 1]')
  assert.equal(parts[1].filename, 'pasted image.png')
  assert.equal(parts[1].source.path, path)
})

test('numbers pasted images after attachments already staged in the composer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qaa-tui-input-'))
  const path = join(directory, 'third.png')
  await writeFile(path, 'image')

  const parts = await inputPartsFromText(path, [], { attachmentOffset: 2 })

  assert.equal(parts[0].text, '[Image 3]')
  assert.equal(parts[1].source.text.value, '[Image 3]')
})

test('keeps the trusted local path visible for a pasted regular file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qaa-tui-input-'))
  const path = join(directory, 'SKILL.md')
  await writeFile(path, '# Skill')

  const parts = await inputPartsFromText(path)

  assert.equal(parts[0].text, `@${path}`)
  assert.equal(parts[1].source.text.value, `@${path}`)
})

test('replaces a pasted path inside a prompt with an attachment anchor', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qaa-tui-input-'))
  const path = join(directory, 'cat image.png')
  await writeFile(path, 'image')

  const pasted = path.replaceAll(' ', '\\ ')
  const parts = await inputPartsFromText(`${pasted} 这是什么？`)

  assert.equal(parts[0].text, '[Image 1] 这是什么？')
  assert.equal(parts[1].filename, 'cat image.png')
})

test('recognizes an escaped Windows path inside a prompt', () => {
  const text = 'C:\\Users\\alice\\cat\\ image.png 这是什么？'

  assert.deepEqual(pastedPathReferences(text), [{
    path: 'C:\\Users\\alice\\cat image.png',
    start: 0,
    end: 'C:\\Users\\alice\\cat\\ image.png'.length,
  }])
})

test('attaches an existing path whose separator precedes an escapable character', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qaa-tui-input-'))
  // Windows 路径分隔符后紧跟 ( 时，形如 shell 转义的 \( 实际是目录分隔。
  const folder = await mkdtemp(join(directory, '(draft)'))
  const path = join(folder, 'notes.md')
  await writeFile(path, '# notes')

  const pasted = await inputPartsFromText(path)
  assert.equal(pasted[1]?.source.path, path)

  const inline = await inputPartsFromText(`总结 ${path}`)
  assert.equal(inline[0].text, `总结 @${path}`)
  assert.equal(inline[1]?.source.path, path)
})

test('recognizes inline UNC paths without changing literal separators', () => {
  for (const path of [
    String.raw`\\server\share\report.pdf`,
    String.raw`\\server\share\(draft)\notes.md`,
    String.raw`\\server\share\&notes.md`,
  ]) {
    const prefix = '总结 '
    assert.deepEqual(pastedPathReferences(`${prefix}${path} 谢谢`), [{
      path,
      start: prefix.length,
      end: prefix.length + path.length,
    }])
  }
})

test('keeps offsets for multiple drive and UNC paths in one prompt', () => {
  const drive = String.raw`C:\docs\notes.md`
  const shared = String.raw`\\server\share\report.pdf`
  const text = `比较 ${drive} 和 ${shared}`
  const references = pastedPathReferences(text)
  assert.deepEqual(references.map(reference => reference.path), [drive, shared])
  for (const reference of references) {
    assert.equal(text.slice(reference.start, reference.end), reference.path)
  }
})

test('adds a staged attachment reference to the submitted text', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qaa-tui-input-'))
  const path = join(directory, 'screen.png')
  await writeFile(path, 'image')
  const staged = [await filePartFromPath(path)]
  const parts = await inputPartsFromText('这是什么', staged)
  assert.equal(parts[0].text, '[Image 1] 这是什么')
  assert.equal(parts[1].source.text.start, 0)
})

test('keeps ordinary @mentions as text when they are not paths', async () => {
  const parts = await inputPartsFromText('请问 @designer 的意见')
  assert.deepEqual(parts, [{ type: 'text', text: '请问 @designer 的意见' }])
})
