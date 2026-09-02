import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
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
import {
  FrontendReminderStore,
  MAX_REMINDER_TEXT_CHARS,
  ReminderKind,
  ReminderStatus,
  ReminderStoreError,
} from '../src/conversation/frontend-reminders.mjs'

function tempFile(prefix = 'qwen-audio-agent-reminders-') {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  return {
    directory,
    filePath: join(directory, 'frontend-reminders.json'),
  }
}

test('creates reminders and isolates owners', () => {
  let now = 1_000
  const store = new FrontendReminderStore({ now: () => now })
  const reminder = store.create('owner-a', {
    text: '  明天  开会  ',
    executeAt: 2_000,
    timezone: 'Asia/Shanghai',
    recurrence: 'daily',
  })

  assert.equal(reminder.ownerId, 'owner-a')
  assert.equal(reminder.text, '明天 开会')
  assert.equal(reminder.kind, ReminderKind.REMINDER)
  assert.equal(reminder.status, ReminderStatus.ACTIVE)
  assert.equal(reminder.nextFireAt, 2_000)
  assert.equal(store.get('owner-a', reminder.id).id, reminder.id)
  assert.equal(store.get('owner-b', reminder.id), null)
  assert.equal(store.list('owner-b').length, 0)

  now = 1_100
  assert.equal(store.list('owner-a')[0].updatedAt, 1_000)
})

test('validates reminder fields and enforces the owner limit', () => {
  const store = new FrontendReminderStore({ maxRemindersPerOwner: 1 })
  assert.throws(
    () => store.create('', { text: 'x', executeAt: 1 }),
    error => error instanceof ReminderStoreError && error.code === 'invalid_owner',
  )
  assert.throws(
    () => store.create('owner', { text: ' ', executeAt: 1 }),
    error => error.code === 'invalid_text',
  )
  assert.throws(
    () => store.create('owner', {
      text: 'x'.repeat(MAX_REMINDER_TEXT_CHARS + 1),
      executeAt: 1,
    }),
    error => error.code === 'invalid_text',
  )
  assert.throws(
    () => store.create('owner', { text: 'x', executeAt: -1 }),
    error => error.code === 'invalid_execute_at',
  )
  assert.throws(
    () => store.create('owner', { text: 'x', executeAt: 1, kind: 'other' }),
    error => error.code === 'invalid_kind',
  )
  assert.throws(
    () => store.create('owner', { text: 'x', executeAt: 1, recurrence: 'hourly' }),
    error => error.code === 'invalid_recurrence',
  )
  assert.throws(
    () => store.create('owner', { text: 'x', executeAt: 1, timezone: 'Mars/Olympus' }),
    error => error.code === 'invalid_timezone',
  )

  store.create('owner', { text: 'first', executeAt: 1 })
  assert.throws(
    () => store.create('owner', { text: 'second', executeAt: 2 }),
    error => error.code === 'owner_limit',
  )
})

test('persists reminders atomically and restores them with private permissions', t => {
  const { directory, filePath } = tempFile()
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const first = new FrontendReminderStore({ filePath, now: () => 100 })
  const created = first.create('owner-a', {
    text: '提交报告',
    executeAt: 200,
    kind: ReminderKind.TASK,
    recurrence: 'weekly',
    timezone: 'Asia/Shanghai',
  })
  const restored = new FrontendReminderStore({ filePath, now: () => 300 })

  assert.deepEqual(restored.get('owner-a', created.id), created)
  assert.equal(JSON.parse(readFileSync(filePath, 'utf8')).version, 1)
  if (process.platform !== 'win32') {
    assert.equal(statSync(filePath).mode & 0o777, 0o600)
  }
})

test('quarantines corrupt data and remains usable after the warning', t => {
  const { directory, filePath } = tempFile('qwen-audio-agent-reminders-corrupt-')
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  writeFileSync(filePath, '{not-json')
  const warnings = []
  const store = new FrontendReminderStore({
    filePath,
    now: () => 12345,
    onWarning: warning => warnings.push(warning),
  })

  assert.deepEqual(store.list('owner-a'), [])
  assert.equal(warnings.length, 1)
  assert.equal(existsSync(`${filePath}.corrupt-12345`), true)
  const reminder = store.create('owner-a', { text: '恢复后可写', executeAt: 2 })
  assert.equal(store.get('owner-a', reminder.id).text, '恢复后可写')
  assert.equal(store.health().ok, false)
  assert.equal(store.health().persistenceEnabled, true)
})

test('rolls back an in-memory create when persistence is unavailable', t => {
  const { directory } = tempFile('qwen-audio-agent-reminders-write-failure-')
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const warnings = []
  const store = new FrontendReminderStore({
    filePath: directory,
    onWarning: warning => warnings.push(warning),
  })

  assert.throws(
    () => store.create('owner-a', { text: '不能写入', executeAt: 2 }),
    error => error.code === 'persistence_unavailable',
  )
  assert.deepEqual(store.list('owner-a'), [])
  assert.equal(store.health().persistenceEnabled, false)
  assert.equal(warnings.length > 0, true)
})

test('claims due reminders once and completes one-time or recurring lifecycles', () => {
  const ids = ['rem_one', 'rem_recurring', 'rem_future']
  const store = new FrontendReminderStore({
    now: () => 1_000,
    idFactory: () => ids.shift(),
  })
  const oneTime = store.create('owner-a', { text: '一次', executeAt: 900 })
  const recurring = store.create('owner-a', {
    text: '每天',
    executeAt: 900,
    recurrence: 'daily',
  })
  const future = store.create('owner-a', { text: '未来', executeAt: 2_000 })

  assert.deepEqual(store.due({ at: 1_000 }).map(item => item.id), [oneTime.id, recurring.id])
  const claimed = store.claimDue({ at: 1_000 })
  assert.deepEqual(claimed.map(item => item.id), [oneTime.id, recurring.id])
  assert.equal(store.claimDue({ at: 1_000 }).length, 0)
  assert.equal(store.get('owner-a', oneTime.id).fireCount, 1)
  assert.equal(store.get('owner-a', future.id).status, ReminderStatus.ACTIVE)

  assert.equal(store.complete('owner-a', oneTime.id, { at: 1_100 }).status, ReminderStatus.COMPLETED)
  const next = store.complete('owner-a', recurring.id, {
    at: 1_100,
    nextFireAt: 2_000,
  })
  assert.equal(next.status, ReminderStatus.ACTIVE)
  assert.equal(next.nextFireAt, 2_000)
})

test('requires explicit next fire times for recurring reminders', () => {
  const store = new FrontendReminderStore({ now: () => 1_000 })
  const reminder = store.create('owner-a', {
    text: '重复',
    executeAt: 900,
    recurrence: 'daily',
  })
  store.claimDue({ at: 1_000 })

  assert.throws(
    () => store.complete('owner-a', reminder.id, { at: 1_100 }),
    error => error.code === 'next_fire_required',
  )
  assert.equal(store.get('owner-a', reminder.id).status, ReminderStatus.FIRING)
})

test('cancels only the owner-owned reminder and is idempotent', () => {
  const store = new FrontendReminderStore({ now: () => 1_000 })
  const reminder = store.create('owner-a', { text: '取消我', executeAt: 900 })

  assert.equal(store.cancel('owner-b', reminder.id), null)
  assert.equal(store.cancel('owner-a', reminder.id).status, ReminderStatus.CANCELLED)
  assert.equal(store.cancel('owner-a', reminder.id).status, ReminderStatus.CANCELLED)
  assert.equal(store.claimDue({ at: 2_000 }).length, 0)
})

test('reopens an interrupted firing reminder after restart', t => {
  const { directory, filePath } = tempFile('qwen-audio-agent-reminders-recovery-')
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const first = new FrontendReminderStore({ filePath, now: () => 1_000 })
  const reminder = first.create('owner-a', { text: '恢复', executeAt: 900 })
  first.claimDue({ at: 1_000 })

  const restored = new FrontendReminderStore({ filePath, now: () => 2_000 })
  assert.equal(restored.get('owner-a', reminder.id).status, ReminderStatus.ACTIVE)
  assert.equal(restored.due({ at: 2_000 }).length, 1)
})

test('merges writes from two Gateway instances sharing one file', t => {
  const { directory, filePath } = tempFile('qwen-audio-agent-reminders-shared-')
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const first = new FrontendReminderStore({ filePath, now: () => 1_000 })
  const second = new FrontendReminderStore({ filePath, now: () => 1_100 })
  first.create('owner-a', { text: '来自 CLI', executeAt: 2_000 })
  second.create('owner-a', { text: '来自桌面', executeAt: 3_000 })

  assert.deepEqual(first.list('owner-a').map(item => item.text), ['来自 CLI', '来自桌面'])
})

test('serializes concurrent reminder creation from independent processes', async t => {
  const { directory, filePath } = tempFile('qwen-audio-agent-reminders-processes-')
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const moduleUrl = new URL('../src/conversation/frontend-reminders.mjs', import.meta.url).href
  const texts = Array.from({ length: 8 }, (_, index) => `process-${index}`)
  const script = `
    import { FrontendReminderStore } from ${JSON.stringify(moduleUrl)}
    const store = new FrontendReminderStore({ filePath: process.argv[1] })
    store.create('owner-a', { text: process.argv[2], executeAt: 1000 })
  `
  await Promise.all(texts.map(text => new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [
      '--input-type=module',
      '-e',
      script,
      filePath,
      text,
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', rejectPromise)
    child.once('exit', code => {
      if (code === 0) resolvePromise()
      else rejectPromise(new Error(`child exited ${code}: ${stderr}`))
    })
  })))

  const store = new FrontendReminderStore({ filePath })
  assert.deepEqual(store.list('owner-a').map(item => item.text).sort(), texts.sort())
})
