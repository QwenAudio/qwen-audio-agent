import assert from 'node:assert/strict'
import test from 'node:test'
import { MarkdownMemoryProvider } from '../src/conversation/memory/providers/markdown/provider.mjs'

function document(scope, content) {
  let value = content
  const store = {
    list: ownerId => value ? [{
      id: `${scope}_${ownerId}`,
      scope,
      content: value,
      revision: `${scope}-revision`,
      format: 'markdown',
    }] : [],
    edit: (_ownerId, change) => {
      value = `${value}\n${change.append || ''}`.trim()
      return { changed: 1, document: { scope, content: value } }
    },
    prepareEdit: (_ownerId, change) => {
      let next = value
      for (const edit of change.edits || []) {
        next = next.replace(edit.old_text, edit.new_text)
      }
      next = `${next}\n${change.append || ''}`.trim()
      return {
        changed: 1,
        content: next,
        document: { scope, content: next },
      }
    },
    persist: (_ownerId, contentValue) => { value = contentValue.trim() },
    health: () => ({ ok: true, configured: true, warning: null }),
  }
  return store
}

test('lists user preferences and long-term memory as separate Markdown documents', () => {
  const store = new MarkdownMemoryProvider({
    userStore: document('user', '# USER\n\n- 称呼：船长'),
    memoryStore: document('memory', '# MEMORY\n\n- 喜欢篮球'),
  })
  assert.deepEqual(store.list('owner').map(item => item.scope), ['user', 'memory'])
  assert.match(store.list('owner', { scope: 'user' })[0].content, /船长/)
  assert.match(store.list('owner', { scope: 'long_term' })[0].content, /篮球/)
})

test('applies one Markdown change to the selected document', () => {
  const userStore = document('user', '# USER')
  const memoryStore = document('memory', '# MEMORY')
  const store = new MarkdownMemoryProvider({ userStore, memoryStore })
  const result = store.apply('owner', [{
    document: 'profile',
    append: '## 称呼\n\n- 船长',
  }])
  assert.equal(result.changed, 1)
  assert.match(store.list('owner', { scope: 'user' })[0].content, /船长/)
  assert.doesNotMatch(store.list('owner', { scope: 'memory' })[0].content, /船长/)
})

test('rejects changes without a concrete document', () => {
  const store = new MarkdownMemoryProvider({
    userStore: document('user', '# USER'),
    memoryStore: document('memory', '# MEMORY'),
  })
  assert.throws(() => store.apply('owner', [{ append: '- 内容' }]), /concrete document/)
})

test('prepares both documents before applying a cross-document change', () => {
  const store = new MarkdownMemoryProvider({
    userStore: document('user', '# USER'),
    memoryStore: document('memory', '# MEMORY\n\n- 用户希望被称呼为老板'),
  })
  const result = store.apply('owner', [
    { document: 'user', append: '- 助手称呼用户：老大' },
    {
      document: 'memory',
      edits: [{ old_text: '- 用户希望被称呼为老板', new_text: '' }],
    },
  ])
  assert.equal(result.changed, 2)
  assert.equal(result.documents.length, 2)
  assert.match(store.list('owner', { scope: 'user' })[0].content, /老大/)
  assert.doesNotMatch(store.list('owner', { scope: 'memory' })[0].content, /老板/)
})
