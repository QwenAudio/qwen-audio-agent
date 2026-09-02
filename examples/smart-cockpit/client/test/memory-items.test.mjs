import assert from 'node:assert/strict'
import test from 'node:test'
import { memoryItemsFromDocuments } from '../src/projections/memory-items.js'

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
