import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MarkdownContextStore } from '../src/conversation/markdown-context-store.mjs'

function store(scope = 'memory', options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'qwaudio-markdown-memory-'))
  const filePath = join(directory, scope === 'user' ? 'USER.md' : 'MEMORY.md')
  const warnings = []
  return {
    filePath,
    warnings,
    store: new MarkdownContextStore({
      filePath,
      scope,
      template: scope === 'user' ? '# USER' : '# MEMORY',
      onWarning: warning => warnings.push(warning),
      ...options,
    }),
  }
}

test('keeps memory content as ordinary human-readable Markdown', () => {
  const { store: memory, filePath } = store()
  const result = memory.edit('user_personal', {
    append: '## 兴趣\n\n- 用户喜欢打篮球。',
  })
  assert.equal(result.changed, 1)
  assert.equal(
    readFileSync(filePath, 'utf8'),
    '# MEMORY\n\n## 兴趣\n\n- 用户喜欢打篮球。\n',
  )
  assert.equal(memory.list('user_personal')[0].format, 'markdown')
})

test('applies multiple exact edits atomically for updates and deletion', () => {
  const { store: memory } = store()
  const first = memory.edit('user_personal', {
    append: '## 用户\n\n- 称呼为老板。\n- 喜欢篮球。',
  })
  const result = memory.edit('user_personal', {
    expectedRevision: first.document.revision,
    edits: [
      { old_text: '- 称呼为老板。', new_text: '- 称呼为船长。' },
      { old_text: '- 喜欢篮球。', new_text: '' },
    ],
  })
  assert.equal(result.changed, 2)
  assert.match(result.document.content, /称呼为船长/)
  assert.doesNotMatch(result.document.content, /喜欢篮球/)
})

test('rejects stale revisions and removes duplicate or empty bullet placeholders', () => {
  const { store: memory, filePath } = store()
  const first = memory.edit('user_personal', { append: '- \n- 相同\n- 相同' })
  assert.throws(() => memory.edit('user_personal', {
    expectedRevision: 'stale',
    append: '- 新内容',
  }), error => error.code === 'stale_document')
  const unchanged = memory.edit('user_personal', {
    expectedRevision: first.document.revision,
    append: '- 相同',
  })
  assert.equal(unchanged.changed, 0)
  assert.equal(readFileSync(filePath, 'utf8'), '# MEMORY\n\n- 相同\n')
})

test('isolates non-personal owners into separate Markdown files', () => {
  const { store: memory, filePath } = store()
  memory.edit('owner-a', { append: '- A 的记忆' })
  memory.edit('owner-b', { append: '- B 的记忆' })
  assert.equal(memory.read('user_personal'), '')
  assert.equal(memory.read('owner-a').includes('A 的记忆'), true)
  assert.equal(memory.read('owner-b').includes('B 的记忆'), true)
  assert.throws(() => readFileSync(filePath, 'utf8'), /ENOENT/)
})

test('writes past the injection budget instead of failing, and truncates on read', () => {
  const { store: memory, filePath, warnings } = store('memory', { maxChars: 200 })
  const long = `- ${'长'.repeat(400)}`
  const result = memory.edit('user_personal', { append: long })

  // 写入成功，且磁盘上保留全量（不再抛 document_too_large）
  assert.equal(result.changed, 1)
  const onDisk = readFileSync(filePath, 'utf8')
  assert.equal([...onDisk].length > 200, true)
  assert.equal(onDisk.includes('长'.repeat(400)), true)

  // 注入侧截断并带标记
  const injected = memory.read('user_personal')
  assert.equal([...injected].length <= 200 + 40, true)
  assert.match(injected, /已截断/)

  // 明确告警，且写盘成功不会把这个状态清掉
  assert.equal(warnings.some(item => item.overBudget === true), true)
  assert.equal(memory.health().warning?.overBudget, true)
  assert.equal(memory.health().ok, false)
})

test('still refuses writes beyond the absolute ceiling', () => {
  const { store: memory } = store('memory', { maxChars: 100, hardMaxChars: 300 })
  assert.throws(
    () => memory.edit('user_personal', { append: `- ${'字'.repeat(500)}` }),
    error => error.code === 'document_too_large',
  )
})

test('reports an over-budget document on read even without editing', () => {
  const { store: memory, warnings } = store('memory', { maxChars: 120 })
  memory.edit('user_personal', { append: `- ${'甲'.repeat(300)}` })
  warnings.length = 0
  memory.read('user_personal')
  assert.equal(warnings.some(item => item.overBudget === true), true)
})
