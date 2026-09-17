import assert from 'node:assert/strict'
import test from 'node:test'
import { MarkdownContextStore } from '../../../../server/src/memory/providers/markdown/context-store.mjs'
import { memoryDeletionChange, memoryItemsFromDocuments } from '../src/projections/memory-items.js'

test('projects editable Markdown memory without exposing templates or comments', () => {
  const items = memoryItemsFromDocuments([{
    scope: 'user',
    revision: 'r1',
    editable: true,
    content: [
      '# USER',
      '<!-- template hint -->',
      '## 交互偏好',
      '- 默认使用简短中文回答',
    ].join('\n'),
  }, {
    scope: 'memory',
    revision: 'r2',
    editable: true,
    content: '# MEMORY\n\n## 项目\n\n- 正在做语音助手',
  }])

  assert.deepEqual(items.map(item => ({
    scope: item.scope,
    section: item.section,
    text: item.text,
    oldText: item.oldText,
  })), [{
    scope: 'user',
    section: '交互偏好',
    text: '默认使用简短中文回答',
    oldText: '- 默认使用简短中文回答',
  }, {
    scope: 'memory',
    section: '项目',
    text: '正在做语音助手',
    oldText: '- 正在做语音助手',
  }])
})

test('ignores read-only and unsupported provider documents', () => {
  assert.deepEqual(memoryItemsFromDocuments([
    { scope: 'memory', revision: 'r', editable: false, content: '- hidden' },
    { scope: 'custom', revision: 'r', editable: true, content: '- hidden' },
  ]), [])
})

// Keep the real provider's revisions, exact-match validation, and Markdown
// normalization, but never access disk or any user's persisted memory.
function deletionFixture(content, { scope = 'memory', maxChars = 8000 } = {}) {
  let source = String(content).replaceAll('\0', '').replace(/\r\n?/gu, '\n').trim()
  const store = new MarkdownContextStore({
    filePath: `/virtual/${scope}.md`, scope, maxChars,
    onWarning() {},
  })
  store.readRaw = () => source
  store.persist = () => assert.fail('deletion regressions must not write files')
  const document = store.list('fixture-owner')[0]
  return {
    store,
    document,
    replaceSource(value) { source = String(value).replace(/\r\n?/gu, '\n').trim() },
    prepare(item, documents = [document]) {
      const original = structuredClone(documents)
      const change = memoryDeletionChange(documents, item)
      assert.equal(change.document, document.scope)
      assert.equal(change.expectedRevision, document.revision)
      assert.equal(change.edits.length, 1)
      assert.equal(typeof change.edits[0].old_text, 'string')
      assert.equal(typeof change.edits[0].new_text, 'string')
      assert.deepEqual(documents, original, 'building a deletion must not mutate API snapshots')
      return { change, result: store.prepareEdit('fixture-owner', change) }
    },
  }
}

function projectedTexts(document) {
  return memoryItemsFromDocuments([document]).map(item => item.text)
}

test('deletes a visible fact even when its exact text also occurs in a hidden template comment', () => {
  const row = '- 助手称呼用户：老大'
  const fixture = deletionFixture([
    '# USER',
    `<!-- 例如：${row} -->`,
    '## 称呼',
    row,
    '- 另一个偏好',
  ].join('\n'), { scope: 'user' })
  const [item] = memoryItemsFromDocuments([fixture.document])
  assert.ok(Number.isInteger(item.lineIndex))
  assert.throws(() => fixture.store.prepareEdit('fixture-owner', {
    expectedRevision: fixture.document.revision,
    edits: [{ old_text: item.oldText, new_text: '' }],
  }), error => error.code === 'ambiguous_edit', 'the original raw-line deletion must reproduce the bug')

  const { result } = fixture.prepare(item)
  assert.ok(result.content.includes(`<!-- 例如：${row} -->`))
  assert.deepEqual(projectedTexts(result.document), ['另一个偏好'])
})

test('deleting a short fact never damages a longer fact with the same prefix', () => {
  const fixture = deletionFixture('# MEMORY\n- 喜欢茶\n- 喜欢茶和咖啡\n- 喜欢散步')
  const item = memoryItemsFromDocuments([fixture.document]).find(entry => entry.text === '喜欢茶')
  const { result } = fixture.prepare(item)
  assert.deepEqual(projectedTexts(result.document), ['喜欢茶和咖啡', '喜欢散步'])
})

for (const selectedSection of ['第一组', '第二组']) {
  test(`removes only the selected occurrence of a repeated row in ${selectedSection}`, () => {
    const fixture = deletionFixture([
      '# MEMORY', '## 第一组', '- 相同条目', '## 第二组', '- 相同条目', '- 保留条目',
    ].join('\n'))
    const item = memoryItemsFromDocuments([fixture.document])
      .find(entry => entry.section === selectedSection && entry.text === '相同条目')
    const { result } = fixture.prepare(item)
    const remaining = memoryItemsFromDocuments([result.document])
    assert.deepEqual(remaining.filter(entry => entry.text === '相同条目').map(entry => entry.section), [
      selectedSection === '第一组' ? '第二组' : '第一组',
    ])
    assert.ok(remaining.some(entry => entry.text === '保留条目'))
  })
}

test('deleting one of three repeated rows keeps both unselected sections', () => {
  const fixture = deletionFixture([
    '# MEMORY', '## 第一组', '- 相同条目', '## 第二组', '- 相同条目',
    '## 第三组', '- 相同条目', '- 保留条目',
  ].join('\n'))
  const item = memoryItemsFromDocuments([fixture.document])
    .find(entry => entry.section === '第二组' && entry.text === '相同条目')
  const { result } = fixture.prepare(item)
  const remaining = memoryItemsFromDocuments([result.document])
  assert.deepEqual(remaining.filter(entry => entry.text === '相同条目').map(entry => entry.section), [
    '第一组', '第三组',
  ])
  assert.equal(result.content, fixture.document.content.replace('## 第二组\n- 相同条目\n', '## 第二组\n'))
})

test('CRLF snapshots produce an edit accepted by the real normalized Markdown store', () => {
  const fixture = deletionFixture('# MEMORY\r\n- 删除条目\r\n- 保留条目\r\n')
  const documents = [{ ...fixture.document, content: fixture.document.content.replaceAll('\n', '\r\n') }]
  const [item] = memoryItemsFromDocuments(documents)
  const { result } = fixture.prepare(item, documents)
  assert.deepEqual(projectedTexts(result.document), ['保留条目'])
  assert.doesNotMatch(result.content, /\r/u)
})

test('deletes the last row without requiring a trailing newline', () => {
  const fixture = deletionFixture('# MEMORY\n- 保留条目\n- 最后一条')
  const item = memoryItemsFromDocuments([fixture.document]).at(-1)
  const { result } = fixture.prepare(item)
  assert.deepEqual(projectedTexts(result.document), ['保留条目'])
})

for (const [name, content, preservedComment] of [
  ['inline comment', '# MEMORY\n- 删除<!-- 内联说明 -->条目\n- 保留条目', '<!-- 内联说明 -->'],
  ['multiline comment ending on the selected row', '# MEMORY\n<!-- 前置注释\n内部说明 --> - 删除条目\n- 保留条目', '<!-- 前置注释\n内部说明 -->'],
  ['multiline comment beginning on the selected row', '# MEMORY\n- 删除条目 <!-- 后置注释\n内部说明\n-->\n- 保留条目', '<!-- 后置注释\n内部说明\n-->'],
]) {
  test(`deleting visible content preserves the ${name}`, () => {
    const fixture = deletionFixture(content)
    const item = memoryItemsFromDocuments([fixture.document]).find(entry => entry.text === '删除条目')
    assert.ok(item)
    const { result } = fixture.prepare(item)
    assert.ok(result.content.includes(preservedComment))
    assert.deepEqual(projectedTexts(result.document), ['保留条目'])
  })
}

test('rejects missing revisions, stale items, and invalid row targets without changing a snapshot', () => {
  const fixture = deletionFixture('# MEMORY\n<!-- 隐藏说明 -->\n- 目标条目\n- 保留条目')
  const documents = [fixture.document]
  const original = structuredClone(documents)
  const [item] = memoryItemsFromDocuments(documents)
  const cases = [
    [documents, { ...item, revision: '' }],
    [[{ ...fixture.document, revision: '' }], item],
    [documents, { ...item, revision: 'stale-revision' }],
    [documents, { ...item, lineIndex: -1 }],
    [documents, { ...item, lineIndex: 99 }],
    [documents, { ...item, lineIndex: 0 }],
    [documents, { ...item, lineIndex: 1 }],
    [documents, { ...item, oldText: '- 不是原文' }],
    [[{ ...fixture.document, editable: false }], item],
    [[], item],
  ]
  for (const [snapshot, target] of cases) {
    assert.throws(() => memoryDeletionChange(snapshot, target))
  }
  assert.deepEqual(documents, original)

  const change = memoryDeletionChange(documents, item)
  fixture.replaceSource(`${fixture.document.content}\n- 并发新增条目`)
  assert.throws(() => memoryDeletionChange(fixture.store.list('fixture-owner'), item))
  assert.throws(() => fixture.store.prepareEdit('fixture-owner', change), error => error.code === 'stale_document')
  assert.match(fixture.store.readRaw(), /并发新增条目/u)
})

test('deletes a complete row from an 8000-character snapshot without including its synthetic warning or losing the hidden tail', () => {
  const hiddenTail = '\n- 超过显示预算的尾部条目'
  const longRow = `- ${'长'.repeat(8200)}`
  const fixture = deletionFixture(`# MEMORY\n- 完整目标条目\n${longRow}${hiddenTail}`)
  assert.match(fixture.document.content, /内容过长，已截断/u)
  assert.doesNotMatch(fixture.document.content, /超过显示预算的尾部条目/u)
  const item = memoryItemsFromDocuments([fixture.document]).find(entry => entry.text === '完整目标条目')
  const { change, result } = fixture.prepare(item)
  assert.doesNotMatch(change.edits[0].old_text, /内容过长，已截断/u)
  assert.doesNotMatch(change.edits[0].new_text, /内容过长，已截断/u)
  assert.ok(result.content.includes(longRow))
  assert.ok(result.content.endsWith(hiddenTail))
  assert.doesNotMatch(result.content, /完整目标条目|内容过长，已截断/u)
})

test('refuses deletion of the partial final row cut by the Markdown display budget', () => {
  const fixture = deletionFixture(`# MEMORY\n- 完整条目\n- ${'长'.repeat(8200)}\n- 未显示的尾部`)
  const original = structuredClone(fixture.document)
  const incomplete = memoryItemsFromDocuments([fixture.document]).find(entry => entry.text.startsWith('长'))
  assert.ok(incomplete)
  assert.throws(() => memoryDeletionChange([fixture.document], incomplete))
  assert.deepEqual(fixture.document, original)
  assert.match(fixture.store.readRaw(), /未显示的尾部/u)
})
