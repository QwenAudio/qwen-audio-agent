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
import { FrontendNotesStore } from '../src/conversation/frontend-notes.mjs'

test('adds items to a named list, deduplicates and isolates owners', () => {
  const store = new FrontendNotesStore()
  const result = store.add('owner-a', { list: '购物清单', items: ['牛奶', '面包', '牛奶'] })

  assert.deepEqual(result, {
    status: 'ok',
    list: '购物清单',
    added: ['牛奶', '面包'],
    duplicates: ['牛奶'],
  })
  store.add('owner-a', { list: '购物清单', items: ['鸡蛋'] })
  assert.deepEqual(
    store.show('owner-a', '购物清单').items.map(item => item.text),
    ['牛奶', '面包', '鸡蛋'],
  )
  assert.deepEqual(store.lists('owner-a').map(list => list.list), ['购物清单'])
  assert.deepEqual(store.lists('owner-b'), [])
})

test('matches a spoken list name against existing lists', () => {
  const store = new FrontendNotesStore()
  store.add('owner-a', { list: '购物清单', items: ['牛奶'] })

  assert.equal(store.show('owner-a', '购物').list, '购物清单')
  assert.equal(store.show('owner-a', '购物清单').list, '购物清单')

  const missing = store.show('owner-a', '书单')
  assert.equal(missing.status, 'not_found')
  assert.deepEqual(missing.candidates, ['购物清单'])

  store.add('owner-a', { list: '书单', items: ['三体'] })
  assert.equal(store.show('owner-a', '书').list, '书单')
  const ambiguous = store.show('owner-a', '单')
  assert.equal(ambiguous.status, 'ambiguous')
  assert.deepEqual(ambiguous.candidates.sort(), ['书单', '购物清单'])
})

test('removes items by exact, substring and ambiguous matching', () => {
  const store = new FrontendNotesStore()
  store.add('owner-a', {
    list: '购物清单',
    items: ['牛奶', '酸奶', '面包'],
  })

  const result = store.remove('owner-a', { list: '购物清单', items: ['牛', '酸奶', '咖啡'] })
  assert.deepEqual(result.removed, ['牛奶', '酸奶'])
  assert.deepEqual(result.not_found, ['咖啡'])
  assert.deepEqual(store.show('owner-a', '购物清单').items.map(item => item.text), ['面包'])
})

test('bounds list count and per-list item count', () => {
  const store = new FrontendNotesStore()
  const items = Array.from({ length: 120 }, (_, index) => `条目-${index}`)
  const result = store.add('owner-a', { list: '长清单', items })

  assert.equal(result.added.length, 100)
  assert.equal(store.show('owner-a', '长清单').items.length, 100)

  for (let index = 1; index < 20; index += 1) {
    store.add('owner-a', { list: `清单-${String(index).padStart(2, '0')}`, items: ['占位'] })
  }
  const overflow = store.add('owner-a', { list: '第二十一份', items: ['占位'] })
  assert.equal(overflow.status, 'list_full')
})

test('clears a list and reports the removed count', () => {
  const store = new FrontendNotesStore()
  store.add('owner-a', { list: '购物清单', items: ['牛奶', '面包'] })

  const result = store.clear('owner-a', '购物清单')
  assert.deepEqual(result, { status: 'ok', list: '购物清单', removed: 2 })
  assert.deepEqual(store.show('owner-a', '购物清单').items, [])
  assert.deepEqual(store.lists('owner-a').map(list => list.list), ['购物清单'])
})

test('drops a whole list and keeps others', () => {
  const store = new FrontendNotesStore()
  store.add('owner-a', { list: '购物清单', items: ['牛奶'] })
  store.add('owner-a', { list: '书单', items: ['三体'] })

  assert.deepEqual(store.drop('owner-a', '购物清单'), { status: 'ok', list: '购物清单' })
  assert.deepEqual(store.lists('owner-a').map(list => list.list), ['书单'])
  assert.equal(store.drop('owner-a', '书单').status, 'ok')
  assert.deepEqual(store.lists('owner-a'), [])
})

test('persists notes atomically with private permissions', t => {
  const directory = mkdtempSync(join(tmpdir(), 'qwen-audio-agent-notes-'))
  t.after(() => rmSync(directory, { recursive: true }))
  const filePath = join(directory, 'frontend-notes.json')
  const first = new FrontendNotesStore({ filePath })
  first.add('owner-a', { list: '购物清单', items: ['牛奶'] })
  const second = new FrontendNotesStore({ filePath })

  assert.deepEqual(second.show('owner-a', '购物清单').items.length, 1)
  if (process.platform !== 'win32') {
    assert.equal(statSync(filePath).mode & 0o777, 0o600)
  }
  assert.equal(JSON.parse(readFileSync(filePath, 'utf8')).version, 1)
})

test('quarantines corrupt notes and continues with an empty writable store', t => {
  const directory = mkdtempSync(join(tmpdir(), 'qwen-audio-agent-notes-corrupt-'))
  t.after(() => rmSync(directory, { recursive: true }))
  const filePath = join(directory, 'frontend-notes.json')
  writeFileSync(filePath, '{not-json')
  const warnings = []
  const store = new FrontendNotesStore({
    filePath,
    now: () => 12345,
    onWarning: warning => warnings.push(warning),
  })

  assert.deepEqual(store.lists('owner-a'), [])
  assert.equal(warnings.length, 1)
  assert.equal(existsSync(`${filePath}.corrupt-12345`), true)
  store.add('owner-a', { list: '购物清单', items: ['牛奶'] })
  assert.equal(store.health().ok, false)
})

test('rolls back additions when persistence is unavailable', t => {
  const directory = mkdtempSync(join(tmpdir(), 'qwen-audio-agent-notes-write-failure-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const warnings = []
  const store = new FrontendNotesStore({
    filePath: directory,
    onWarning: warning => warnings.push(warning),
  })

  assert.throws(() => store.add('owner-a', { list: '购物清单', items: ['牛奶'] }))
  assert.deepEqual(store.lists('owner-a'), [])
  assert.equal(store.health().persistenceEnabled, false)
})
