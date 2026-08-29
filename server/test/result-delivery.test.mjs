import assert from 'node:assert/strict'
import test from 'node:test'
import { TaskManager } from '../src/task/task-manager.mjs'
import { AnnouncementManager } from '../src/voice/announcement/announcement-manager.mjs'
import { recordTaskResult } from '../src/conversation/task-result-projector.mjs'

/**
 * Simulates the realtime-gateway subscriber for task completion delivery.
 *
 * In production this logic lives inside `attachRealtimeGateway`'s
 * `wss.on('connection')` handler.  The harness extracts only the
 * delivery-relevant path so we can verify that a factual Task result reaches
 * AnnouncementManager → frontend.injectResult exactly once — never duplicated by the
 * subsequent `task.notification.pending` event.
 */
function createDeliveryHarness() {
  const injectCalls = []
  const speakCalls = []

  const frontend = {
    ready: true,
    async injectResult(text, origin, context, options) {
      injectCalls.push({ text, origin, context, options })
      return { completed: true, contextInjected: true }
    },
    async speak(text, origin, context, options) {
      speakCalls.push({ text, origin, context, options })
      return { completed: true }
    },
    cancelResponses() {},
  }

  const conversationSync = {
    record() { return null },
    hasEquivalentAssistantSpeech() { return false },
  }

  const taskManager = new TaskManager()
  const ownerId = 'owner-1'
  const sessionId = 'session-1'

  const announcements = new AnnouncementManager({
    getFrontend: () => frontend,
    isDeliveryBlocked: () => false,
    batchWindowMs: 0,
    maxBatchItems: 1,
    onDelivered: taskIds =>
      taskManager.markNotificationsDelivered(taskIds, { claimantId: 'test' }),
  })

  const recordResult = task =>
    recordTaskResult({ conversationSync, ownerId, sessionId, task })

  const claimPendingNotifications = taskIds => {
    const claimed = taskManager.claimNotifications({
      ownerId,
      sessionId,
      includeOtherSessions: false,
      claimantId: 'test',
      taskIds,
    })
    claimed.forEach(task => {
      recordResult(task)
      if (task.status === 'completed') announcements.completed(task)
      if (task.status === 'failed') announcements.failed(task)
    })
  }

  // --- Replicate the gateway subscriber (delivery-relevant paths only) ---
  taskManager.subscribe(event => {
    const task = event.task
    if (event.ownerId !== ownerId) return

    if (event.type === 'task.notification.pending') {
      if (task.sessionId === sessionId) {
        claimPendingNotifications([task.id])
      }
      return
    }

    if (task.sessionId !== sessionId) return

    if (['task.completed', 'task.failed'].includes(event.type)) {
      claimPendingNotifications([task.id])
    }
  })

  return {
    taskManager,
    announcements,
    injectCalls,
    speakCalls,
    ownerId,
    sessionId,
  }
}

async function flush() {
  // Let the AnnouncementManager's setTimeout(0) delivery fire.
  await new Promise(resolve => setTimeout(resolve, 10))
}

test('delegation does not produce a premature voice announcement', async () => {
  const h = createDeliveryHarness()
  let release
  const { id: taskId } = h.taskManager.create({
    objective: '创建贪吃蛇小游戏',
    ownerId: h.ownerId,
    sessionId: h.sessionId,
    runner: async (_objective, { onEvent }) => {
      onEvent({
        type: 'backend.delegated',
        delegation: {
          id: 'delegation-one',
          sessionId: 'project-session-one',
          title: '贪吃蛇小游戏',
        },
      })
      return new Promise(resolve => { release = resolve })
    },
  })

  await new Promise(resolve => setImmediate(resolve))

  assert.equal(h.speakCalls.length, 0, 'delegation must not speak again')
  assert.equal(h.injectCalls.length, 0, 'delegation must not announce as a result')

  release({ content: '完成', metadata: {} })
  await h.taskManager.wait(taskId)
  await flush()
  h.announcements.close()
})

// ---------------------------------------------------------------------------
// Test scenarios
// ---------------------------------------------------------------------------

test('programming task delivers its factual result exactly once', async () => {
  const h = createDeliveryHarness()

  // create() auto-starts the task via queueMicrotask(() => drain())
  const { id: taskId } = h.taskManager.create({
    objective: '编写一个快速排序',
    ownerId: h.ownerId,
    sessionId: h.sessionId,
    runner: async () => ({
      content: '快速排序已实现',
    }),
  })

  await h.taskManager.wait(taskId)
  await flush()

  assert.equal(h.injectCalls.length, 1, 'injectResult must be called exactly once')
  assert.match(h.injectCalls[0].text, /你先前异步执行工作的最终更新/)
  assert.match(h.injectCalls[0].text, /快速排序已实现/)
  assert.equal(h.injectCalls[0].origin, 'announcement')

  // --- speak should not be used (announcement uses injectResult) ---
  assert.equal(h.speakCalls.length, 0, 'speak should not be called for announcements')

  h.announcements.close()
})

test('result-only task injects its factual result once', async () => {
  const h = createDeliveryHarness()

  const { id: taskId } = h.taskManager.create({
    objective: '查询天气',
    ownerId: h.ownerId,
    sessionId: h.sessionId,
    runner: async () => ({
      content: '今天晴，25度。',
    }),
  })

  await h.taskManager.wait(taskId)
  await flush()

  // The factual result is still delivered through the announcement system.
  assert.equal(h.injectCalls.length, 1, 'injectResult called once for result-only task')
  assert.match(h.injectCalls[0].text, /今天晴/)

  h.announcements.close()
})

test('no duplication: task.completed and task.notification.pending both fire but injectResult called once', async () => {
  const h = createDeliveryHarness()

  const { id: taskId } = h.taskManager.create({
    objective: '编写一个快速排序',
    ownerId: h.ownerId,
    sessionId: h.sessionId,
    runner: async () => ({
      content: '快速排序已实现',
    }),
  })

  await h.taskManager.wait(taskId)
  await flush()

  // TaskManager emits both task.completed and task.notification.pending.
  // claimNotifications transitions notificationStatus from 'pending' to
  // 'delivering' on the first call, so the second call returns empty —
  // no duplicate announcement.
  assert.equal(h.injectCalls.length, 1,
    'injectResult must be called exactly once despite two events')

  h.announcements.close()
})

test('multiple programming tasks each get one injected result', async () => {
  const h = createDeliveryHarness()

  // maxBatchItems=1 in the harness forces separate deliveries.
  // Complete and confirm the first task before creating the second
  // so the announcement system is free to accept it.
  const { id: id1 } = h.taskManager.create({
    objective: '实现冒泡排序',
    ownerId: h.ownerId,
    sessionId: h.sessionId,
    runner: async () => ({
      content: '冒泡排序已实现',
    }),
  })

  await h.taskManager.wait(id1)
  await flush()

  // Confirm the first delivery so the second can be scheduled.
  h.announcements.confirmMany([id1])
  await flush()

  const { id: id2 } = h.taskManager.create({
    objective: '实现归并排序',
    ownerId: h.ownerId,
    sessionId: h.sessionId,
    runner: async () => ({
      content: '归并排序已实现',
    }),
  })

  await h.taskManager.wait(id2)
  await flush()

  // --- Two injectResult calls, one per task ---
  assert.equal(h.injectCalls.length, 2, 'two injectResult calls for two tasks')
  assert.match(h.injectCalls[0].text, /冒泡排序/)
  assert.match(h.injectCalls[1].text, /归并排序/)

  h.announcements.close()
})

test('failed task delivers its error via injectResult once', async () => {
  const h = createDeliveryHarness()

  const { id: taskId } = h.taskManager.create({
    objective: '编写一个快速排序',
    ownerId: h.ownerId,
    sessionId: h.sessionId,
    runner: async () => { throw new Error('syntax error in generated code') },
  })

  await h.taskManager.wait(taskId)
  await flush()

  // But the error is still announced via injectResult
  assert.equal(h.injectCalls.length, 1, 'injectResult called once for failed task')
  assert.match(h.injectCalls[0].text, /你先前异步执行工作的最终更新/)
  assert.match(h.injectCalls[0].text, /syntax error/)

  h.announcements.close()
})
