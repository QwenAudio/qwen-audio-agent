import assert from 'node:assert/strict'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { FrontendMemoryStore } from '../src/conversation/frontend-memory.mjs'

test('stores, searches, deduplicates and isolates long-term memories', () => {
  let now = 100
  const store = new FrontendMemoryStore({ now: () => now })
  store.remember('user-one', '用户喜欢回答简洁')
  now += 1
  store.remember('user-one', '用户希望被称为老明')
  store.remember('user-one', '用户希望被称为老明')
  store.remember('user-two', '用户希望被称为小红')

  const matches = store.list('user-one', { query: '老明' })
  assert.equal(matches.length, 1)
  assert.match(matches[0].id, /^mem_[a-f0-9]{16}$/)
  assert.equal(matches[0].scope, 'long_term')
  assert.equal(matches[0].content, '用户希望被称为老明')
  assert.equal(matches[0].editable, true)
  assert.equal(store.list('user-one').length, 2)
  assert.equal(store.list('user-two')[0].content, '用户希望被称为小红')
  assert.equal(store.forget('user-one', { query: matches[0].id }), 1)
  assert.equal(store.list('user-one').length, 1)
  assert.equal(store.forget('user-one', { all: true }), 1)
  assert.deepEqual(store.list('user-one'), [])
})

test('bounds long-term memory content and per-user entry count', () => {
  const store = new FrontendMemoryStore()
  const remembered = store.remember('user-one', 'v'.repeat(600))

  assert.equal([...remembered.content].length, 500)
  for (let index = 1; index < 32; index += 1) {
    store.remember('user-one', `value-${index}`)
  }
  assert.throws(
    () => store.remember('user-one', 'too much'),
    /最多保存 32 条/,
  )
})

test('atomically replaces multiple old text memories by stable id', () => {
  const store = new FrontendMemoryStore()
  const first = store.remember('user-one', '苹果')
  const second = store.remember('user-one', '喜欢吃苹果')
  store.remember('user-one', '打篮球')

  const result = store.replace('user-one', {
    ids: [first.id, second.id],
    content: '用户最喜欢的水果是香蕉',
  })

  assert.equal(result.replaced, 2)
  assert.equal(result.memory.content, '用户最喜欢的水果是香蕉')
  assert.deepEqual(
    store.list('user-one').map(entry => entry.content).sort(),
    ['打篮球', '用户最喜欢的水果是香蕉'].sort(),
  )
})

test('does not add replacement text when target ids are stale', () => {
  const store = new FrontendMemoryStore()
  store.remember('user-one', '喜欢苹果')

  assert.deepEqual(store.replace('user-one', {
    ids: ['mem_missing'],
    content: '喜欢香蕉',
  }), {
    replaced: 0,
    memory: null,
  })
  assert.deepEqual(
    store.list('user-one').map(entry => entry.content),
    ['喜欢苹果'],
  )
})

test('stores user rules in their own bounded scope', () => {
  const store = new FrontendMemoryStore()
  const rule = store.remember('user-one', '回复默认先给结论', { scope: 'rules' })
  store.remember('user-one', '用户喜欢苹果')

  assert.equal(rule.scope, 'rules')
  assert.deepEqual(
    store.list('user-one', { scope: 'rules' }).map(entry => entry.content),
    ['回复默认先给结论'],
  )
  assert.deepEqual(
    store.list('user-one', { scope: 'long_term' }).map(entry => entry.content),
    ['用户喜欢苹果'],
  )
  assert.equal(store.list('user-one').length, 2)
})

test('bounds rules to sixteen short entries separately from long-term memory', () => {
  const store = new FrontendMemoryStore()
  const rule = store.remember('user-one', 'r'.repeat(300), { scope: 'rules' })
  assert.equal([...rule.content].length, 200)

  for (let index = 1; index < 16; index += 1) {
    store.remember('user-one', `rule-${index}`, { scope: 'rules' })
  }
  assert.throws(
    () => store.remember('user-one', 'one rule too many', { scope: 'rules' }),
    /最多保存 16 条长期约定/,
  )
  // The rules cap does not consume the long-term allowance.
  assert.doesNotThrow(() => store.remember('user-one', '普通记忆'))
})

test('moves a memory between scopes through replace', () => {
  const store = new FrontendMemoryStore()
  const old = store.remember('user-one', '回复要简短')

  const result = store.replace('user-one', {
    ids: [old.id],
    content: '回复默认先给结论，再展开细节',
    scope: 'rules',
  })

  assert.equal(result.replaced, 1)
  assert.equal(result.memory.scope, 'rules')
  assert.deepEqual(store.list('user-one', { scope: 'long_term' }), [])
  assert.equal(store.list('user-one', { scope: 'rules' })[0].id, result.memory.id)
})

test('enforces the rules cap when content collides with another scope', () => {
  const store = new FrontendMemoryStore()
  for (let index = 0; index < 16; index += 1) {
    store.remember('user-one', `rule-${index}`, { scope: 'rules' })
  }
  const longTerm = store.remember('user-one', '跨作用域的同款内容')

  // remember: identical content already lives in long_term, so the write
  // would migrate that entry into the already full rules scope.
  assert.throws(
    () => store.remember('user-one', '跨作用域的同款内容', { scope: 'rules' }),
    /最多保存 16 条长期约定/,
  )
  assert.equal(store.list('user-one', { scope: 'rules' }).length, 16)
  assert.equal(store.list('user-one', { scope: 'long_term' })[0].id, longTerm.id)

  // replace: the surviving collision entry would be migrated into the full
  // rules scope; the store must reject the write and roll back.
  const other = store.remember('user-one', '另一条普通记忆')
  assert.throws(
    () => store.replace('user-one', {
      ids: [other.id],
      content: '跨作用域的同款内容',
      scope: 'rules',
    }),
    /最多保存 16 条长期约定/,
  )
  assert.equal(store.list('user-one', { scope: 'rules' }).length, 16)
  assert.equal(store.list('user-one', { scope: 'long_term' }).length, 2)

  // An in-place update of an existing rule stays allowed at the cap.
  const existingRule = store.list('user-one', { scope: 'rules' })[0]
  assert.doesNotThrow(() => store.replace('user-one', {
    ids: [existingRule.id],
    content: '改写后的规则措辞',
    scope: 'rules',
  }))
  assert.equal(store.list('user-one', { scope: 'rules' }).length, 16)
})

test('forgets by scope without touching the other scopes', () => {
  const store = new FrontendMemoryStore()
  store.remember('user-one', '叫我阿豪', { scope: 'rules' })
  store.remember('user-one', '用户喜欢苹果')

  assert.equal(store.forget('user-one', { all: true, scope: 'rules' }), 1)
  assert.deepEqual(
    store.list('user-one').map(entry => entry.content),
    ['用户喜欢苹果'],
  )
  assert.equal(store.forget('user-one', { query: '苹果', scope: 'rules' }), 0)
  assert.equal(store.forget('user-one', { query: '苹果', scope: 'long_term' }), 1)
  assert.deepEqual(store.list('user-one'), [])
})

test('keeps rule scopes across a persistence reload', t => {
  const directory = mkdtempSync(join(tmpdir(), 'qwen-audio-agent-rules-'))
  t.after(() => rmSync(directory, { recursive: true }))
  const filePath = join(directory, 'frontend-memory.json')
  const first = new FrontendMemoryStore({ filePath })
  first.remember('user-one', '回复默认先给结论', { scope: 'rules' })

  const second = new FrontendMemoryStore({ filePath })
  assert.deepEqual(
    second.list('user-one', { scope: 'rules' }).map(entry => entry.scope),
    ['rules'],
  )
})

test('persists memory atomically with private permissions', t => {
  const directory = mkdtempSync(join(tmpdir(), 'qwen-audio-agent-memory-'))
  t.after(() => rmSync(directory, { recursive: true }))
  const filePath = join(directory, 'frontend-memory.json')
  const first = new FrontendMemoryStore({ filePath })
  first.remember('user-one', '用户偏好中文')
  const second = new FrontendMemoryStore({ filePath })

  assert.equal(second.list('user-one')[0].content, '用户偏好中文')
  if (process.platform !== 'win32') {
    assert.equal(statSync(filePath).mode & 0o777, 0o600)
  }
  assert.equal(JSON.parse(readFileSync(filePath, 'utf8')).version, 1)
})

test('loads legacy key-value memory as scoped content', t => {
  const directory = mkdtempSync(join(tmpdir(), 'qwen-audio-agent-memory-legacy-'))
  t.after(() => rmSync(directory, { recursive: true }))
  const filePath = join(directory, 'frontend-memory.json')
  writeFileSync(filePath, JSON.stringify({
    version: 1,
    users: {
      owner: {
        preferred_name: { value: '老大', updatedAt: 10 },
      },
    },
  }))

  const store = new FrontendMemoryStore({ filePath })
  assert.deepEqual(store.list('owner'), [{
    id: store.list('owner')[0].id,
    scope: 'long_term',
    content: '老大',
    updated_at: 10,
    editable: true,
  }])
})

test('quarantines corrupt memory and continues with an empty writable store', t => {
  const directory = mkdtempSync(join(tmpdir(), 'qwen-audio-agent-memory-corrupt-'))
  t.after(() => rmSync(directory, { recursive: true }))
  const filePath = join(directory, 'frontend-memory.json')
  writeFileSync(filePath, '{not-json')
  const warnings = []
  const store = new FrontendMemoryStore({
    filePath,
    now: () => 12345,
    onWarning: warning => warnings.push(warning),
  })

  assert.deepEqual(store.list('user-one'), [])
  assert.equal(warnings.length, 1)
  assert.equal(existsSync(`${filePath}.corrupt-12345`), true)
  store.remember('user-one', '用户偏好中文')
  assert.equal(JSON.parse(readFileSync(filePath, 'utf8')).version, 1)
  assert.equal(store.health().ok, false)
})

test('quarantines structurally invalid memory instead of failing startup', t => {
  const directory = mkdtempSync(join(tmpdir(), 'qwen-audio-agent-memory-invalid-'))
  t.after(() => rmSync(directory, { recursive: true }))
  const filePath = join(directory, 'frontend-memory.json')
  writeFileSync(filePath, JSON.stringify({ version: 1, users: null }))

  const store = new FrontendMemoryStore({
    filePath,
    now: () => 54321,
    onWarning: () => {},
  })

  assert.deepEqual(store.list('user-one'), [])
  assert.equal(existsSync(`${filePath}.corrupt-54321`), true)
})

test('rolls back updates when persistence is unavailable', t => {
  const directory = mkdtempSync(join(tmpdir(), 'qwen-audio-agent-memory-write-failure-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const warnings = []
  const store = new FrontendMemoryStore({
    filePath: directory,
    onWarning: warning => warnings.push(warning),
  })

  assert.throws(() => store.remember('user-one', '用户偏好中文'))
  assert.deepEqual(store.list('user-one'), [])
  assert.equal(store.health().persistenceEnabled, false)
  assert.equal(warnings.length, 1)
})

test('rolls back deletion when persistence is unavailable', t => {
  const directory = mkdtempSync(join(tmpdir(), 'qwen-audio-agent-memory-delete-failure-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const store = new FrontendMemoryStore({ onWarning: () => {} })
  store.remember('user-one', '用户偏好中文')
  store.filePath = directory

  assert.throws(() => store.forget('user-one', { query: '中文' }))
  assert.equal(store.list('user-one')[0].content, '用户偏好中文')
})

test('rolls back replacement when persistence is unavailable', t => {
  const directory = mkdtempSync(join(tmpdir(), 'qwen-audio-agent-memory-replace-failure-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const store = new FrontendMemoryStore({ onWarning: () => {} })
  const old = store.remember('user-one', '喜欢苹果')
  store.filePath = directory

  assert.throws(() => store.replace('user-one', {
    ids: [old.id],
    content: '喜欢香蕉',
  }))
  assert.deepEqual(
    store.list('user-one').map(entry => entry.content),
    ['喜欢苹果'],
  )
})

test('evicts stale and least-recent memory owners', () => {
  let now = 100
  const store = new FrontendMemoryStore({
    maxOwners: 2,
    ownerTtlMs: 50,
    now: () => now,
  })
  store.remember('one', '一')
  now = 110
  store.remember('two', '二')
  now = 120
  store.remember('three', '三')
  assert.deepEqual(store.list('one'), [])
  assert.equal(store.users.size, 2)

  now = 200
  store.pruneOwners()
  assert.equal(store.users.size, 0)
})

test('keeps explicit long-term memories indefinitely when owner TTL is disabled', () => {
  let now = 100
  const store = new FrontendMemoryStore({
    ownerTtlMs: 0,
    now: () => now,
  })
  store.remember('personal', '用户希望被称为老大')
  now = 100 * 365 * 24 * 60 * 60 * 1000
  store.pruneOwners()

  assert.equal(store.list('personal')[0].content, '用户希望被称为老大')
})
