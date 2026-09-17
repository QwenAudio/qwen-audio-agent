import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
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

test('reloads from disk when another instance updated the shared file', t => {
  const root = mkdtempSync(join(tmpdir(), 'frontend-notes-shared-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const filePath = join(root, 'frontend-notes.json')
  // 桌面版与 CLI 双开时是两个进程各持一个 store 实例读写同一文件。
  const cli = new FrontendNotesStore({ filePath })
  const desktop = new FrontendNotesStore({ filePath })
  cli.add('owner-a', { list: '购物清单', items: ['牛奶'] })
  // 另一实例写入后，本实例的下一次读写要先看到磁盘上的最新内容，
  // 而不是用自己的旧缓存整份覆盖回去。
  desktop.add('owner-a', { list: '购物清单', items: ['面包'] })
  const merged = cli.show('owner-a', '购物清单')
  assert.deepEqual(merged.items.map(item => item.text), ['牛奶', '面包'])
  cli.add('owner-a', { list: '购物清单', items: ['鸡蛋'] })
  const final = desktop.show('owner-a', '购物清单')
  assert.deepEqual(final.items.map(item => item.text), ['牛奶', '面包', '鸡蛋'])
})

test('serializes concurrent writes from independent Gateway processes', async t => {
  const root = mkdtempSync(join(tmpdir(), 'frontend-notes-processes-'))
  const children = []
  t.after(async () => {
    await Promise.all(children.filter(child => child.pid && child.exitCode === null && !child.signalCode)
      .map(child => new Promise(resolvePromise => {
        child.once('exit', resolvePromise)
        child.kill()
      })))
    rmSync(root, { recursive: true, force: true })
  })
  const filePath = join(root, 'frontend-notes.json')
  const moduleUrl = new URL('../src/conversation/frontend-notes.mjs', import.meta.url).href
  const items = Array.from({ length: 12 }, (_, index) => `item-${index}`)
  const rounds = 4
  let ready = 0
  const script = `
    import { FrontendNotesStore } from ${JSON.stringify(moduleUrl)}
    const store = new FrontendNotesStore({ filePath: process.argv[1] })
    process.once('message', () => {
      for (let round = 0; round < ${rounds}; round += 1) {
        store.add('owner-a', { list: 'shared', items: [process.argv[2] + '-' + round] })
        store.show('owner-a', 'shared')
      }
      process.disconnect()
    })
    process.send('ready')
  `
  await Promise.all(items.map(item => new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, filePath, item], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    children.push(child)
    // Start every writer together, rather than relying on process launch timing.
    child.once('message', () => {
      ready += 1
      if (ready === items.length) children.forEach(writer => writer.send('start'))
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', rejectPromise)
    child.once('exit', code => {
      if (code === 0) resolvePromise()
      else rejectPromise(new Error(`child exited ${code}: ${stderr}`))
    })
  })))

  const result = new FrontendNotesStore({ filePath }).show('owner-a', 'shared')
  const expected = items.flatMap(item => Array.from({ length: rounds }, (_, round) => `${item}-${round}`))
  assert.deepEqual(result.items.map(item => item.text).sort(), expected.sort())
})

for (const operation of ['initialize', 'refresh']) {
  test(`holds the shared lock while reading notes to ${operation}`, t => {
    const root = mkdtempSync(join(tmpdir(), 'frontend-notes-read-lock-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const filePath = join(root, 'frontend-notes.json')
    const first = new FrontendNotesStore({ filePath })
    first.add('owner-a', { list: 'shared', items: ['first'] })
    const reader = operation === 'refresh' ? new FrontendNotesStore({ filePath }) : null
    first.add('owner-a', { list: 'shared', items: ['second'] })

    const originalRead = fs.readFileSync
    let reads = 0
    const mocked = t.mock.method(fs, 'readFileSync', (path, ...args) => {
      if (path === filePath) {
        reads += 1
        // Model the Windows replacement window: an unlocked reader can get
        // EPERM rather than a valid snapshot. Locked readers cannot overlap it.
        if (!existsSync(`${filePath}.lock`)) {
          throw Object.assign(new Error('file is being replaced'), { code: 'EPERM' })
        }
      }
      return originalRead(path, ...args)
    })
    syncBuiltinESMExports()
    t.after(() => {
      mocked.mock.restore()
      syncBuiltinESMExports()
    })
    const warnings = []
    const store = reader || new FrontendNotesStore({
      filePath,
      onWarning: warning => warnings.push(warning),
    })
    if (reader) reader.onWarning = warning => warnings.push(warning)
    const result = store.show('owner-a', 'shared')
    assert.equal(result.status, 'ok')
    assert.deepEqual(result.items.map(item => item.text), [
      'first', 'second',
    ])
    assert.ok(reads > 0)
    assert.equal(store.health().persistenceEnabled, true)
    assert.deepEqual(warnings, [])
    assert.equal(existsSync(`${filePath}.lock`), false)
  })
}
