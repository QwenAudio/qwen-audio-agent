import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ProgressAnnouncementManager,
} from '../src/voice/announcement/progress-announcement-manager.mjs'

function clock(start = 1) {
  let now = start
  let nextId = 0
  const timers = []
  const setTimer = (callback, delay) => {
    const timer = {
      id: ++nextId,
      at: now + delay,
      callback,
      cancelled: false,
      unref() {},
    }
    timers.push(timer)
    return timer
  }
  const clearTimer = timer => { timer.cancelled = true }
  const settle = async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  }
  const advance = async milliseconds => {
    const target = now + milliseconds
    while (true) {
      const next = timers
        .filter(timer => !timer.cancelled && timer.at <= target)
        .sort((left, right) => left.at - right.at || left.id - right.id)[0]
      if (!next) break
      next.cancelled = true
      now = next.at
      next.callback()
      await settle()
    }
    now = target
    await settle()
  }
  return { now: () => now, setTimer, clearTimer, advance }
}

function harness(options = {}) {
  const fakeClock = clock()
  const calls = []
  const active = new Set(['task_1', 'task_2'])
  let blocked = false
  let turnSequence = 0
  const manager = new ProgressAnnouncementManager({
    getFrontend: () => ({
      async injectResult(...args) {
        calls.push(args)
        return { completed: true }
      },
    }),
    isDeliveryBlocked: () => blocked,
    isTaskActive: taskId => active.has(taskId),
    intervalMs: 60_000,
    quietMs: 0,
    retryMs: 1_000,
    now: fakeClock.now,
    setTimer: fakeClock.setTimer,
    clearTimer: fakeClock.clearTimer,
    createTurnId: () => `gateway-turn-${++turnSequence}`,
    ...options,
  })
  return {
    manager,
    calls,
    active,
    advance: fakeClock.advance,
    now: fakeClock.now,
    setBlocked: value => { blocked = value },
  }
}

test('coalesces Agent message chunks and first speaks after one minute', async () => {
  const testHarness = harness()
  testHarness.manager.offer({
    taskId: 'task_1',
    startedAt: testHarness.now(),
    message: '正在读取资料',
  })
  await testHarness.advance(30_000)
  testHarness.manager.offer({
    taskId: 'task_1',
    startedAt: 1,
    message: '正在读取资料并整理关键结论',
  })
  await testHarness.advance(29_999)
  assert.equal(testHarness.calls.length, 0)

  await testHarness.advance(1)
  assert.equal(testHarness.calls.length, 1)
  assert.match(testHarness.calls[0][0], /正在读取资料并整理关键结论/)
  assert.match(testHarness.calls[0][0], /task_id: task_1/)
  assert.equal(testHarness.calls[0][1], 'progress')
  assert.deepEqual(testHarness.calls[0][2], {
    taskId: 'task_1',
    turnId: 'gateway-turn-1',
    taskIds: ['task_1'],
  })
  assert.match(
    testHarness.calls[0][3].instructions,
    /阶段性更新，不是最终结果/,
  )
  testHarness.manager.close()
})

test('applies a session-wide one-minute interval across concurrent tasks', async () => {
  const testHarness = harness()
  testHarness.manager.offer({
    taskId: 'task_1',
    startedAt: 1,
    message: '第一项工作的更新',
  })
  await testHarness.advance(60_000)
  assert.equal(testHarness.calls.length, 1)

  testHarness.manager.offer({
    taskId: 'task_2',
    startedAt: 1,
    message: '第二项工作的更新',
  })
  await testHarness.advance(59_999)
  assert.equal(testHarness.calls.length, 1)
  await testHarness.advance(1)
  assert.equal(testHarness.calls.length, 2)
  assert.match(testHarness.calls[1][0], /第二项工作的更新/)
  testHarness.manager.close()
})

test('continuous message streaming cannot defer the minute update indefinitely', async () => {
  const testHarness = harness({ quietMs: 800 })
  testHarness.manager.offer({
    taskId: 'task_1',
    startedAt: 1,
    message: '开始整理',
  })
  await testHarness.advance(59_900)
  testHarness.manager.offer({
    taskId: 'task_1',
    startedAt: 1,
    message: '持续整理中的最新文本',
  })
  await testHarness.advance(700)
  testHarness.manager.offer({
    taskId: 'task_1',
    startedAt: 1,
    message: '一分钟窗口内的最后文本',
  })
  await testHarness.advance(199)
  assert.equal(testHarness.calls.length, 0)
  await testHarness.advance(1)
  assert.equal(testHarness.calls.length, 1)
  assert.match(testHarness.calls[0][0], /一分钟窗口内的最后文本/)
  testHarness.manager.close()
})

test('drops pending progress when its task becomes terminal', async () => {
  const testHarness = harness()
  testHarness.manager.offer({
    taskId: 'task_1',
    startedAt: 1,
    message: '即将被最终结果取代的更新',
  })
  testHarness.active.delete('task_1')
  testHarness.manager.remove('task_1')
  await testHarness.advance(60_000)
  assert.deepEqual(testHarness.calls, [])
  testHarness.manager.close()
})

test('waits while voice delivery is blocked without losing the latest update', async () => {
  const testHarness = harness()
  testHarness.setBlocked(true)
  testHarness.manager.offer({
    taskId: 'task_1',
    startedAt: 1,
    message: '等待合适的对话间隙',
  })
  await testHarness.advance(60_000)
  assert.equal(testHarness.calls.length, 0)
  testHarness.setBlocked(false)
  await testHarness.advance(1_000)
  assert.equal(testHarness.calls.length, 1)
  assert.match(testHarness.calls[0][0], /等待合适的对话间隙/)
  testHarness.manager.close()
})
