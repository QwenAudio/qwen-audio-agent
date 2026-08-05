import assert from 'node:assert/strict'
import test from 'node:test'
import { TaskManager } from '../src/task/task-manager.mjs'
import { AnnouncementManager } from '../src/voice/announcement/announcement-manager.mjs'
import { recordTaskResult } from '../src/conversation/task-result-projector.mjs'

const OPEN = 1 // WebSocket.OPEN

/**
 * Simulates the realtime-gateway subscriber for task completion delivery.
 *
 * In production this logic lives inside `attachRealtimeGateway`'s
 * `wss.on('connection')` handler.  The harness extracts only the
 * delivery-relevant paths so we can verify the two independent channels:
 *
 *   1. inline  → timeline.inline  via WebSocket (Realtime model NOT involved)
 *   2. speech  → AnnouncementManager → frontend.injectResult (Realtime model)
 *
 * Each path must fire exactly once per task — never duplicated by the
 * subsequent `task.notification.pending` event.
 */
function createDeliveryHarness() {
  const wsMessages = []
  const injectCalls = []
  const speakCalls = []

  const ws = {
    readyState: OPEN,
    send(data) { wsMessages.push(JSON.parse(data)) },
  }

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

  const send = (socket, event) => {
    if (socket.readyState === OPEN) socket.send(JSON.stringify(event))
  }

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
    if (task.kind === 'control') return

    send(ws, {
      type: event.type,
      task,
      ...(event.permission ? { permission: event.permission } : {}),
    })

    if (['task.completed', 'task.failed'].includes(event.type)) {
      recordResult(task)
      const inline = task.resultMetadata?.presentation?.inline
      if (inline?.content) {
        send(ws, {
          type: 'timeline.inline',
          item: {
            id: `inline_${task.id}`,
            taskId: task.id,
            turnId: task.turnId || null,
            ...inline,
          },
        })
      }
      claimPendingNotifications([task.id])
    }
  })

  return {
    taskManager,
    announcements,
    ws,
    wsMessages,
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

// ---------------------------------------------------------------------------
// Test scenarios
// ---------------------------------------------------------------------------

test('programming task: inline code goes to timeline.inline, speech goes to injectResult, each exactly once', async () => {
  const h = createDeliveryHarness()

  // create() auto-starts the task via queueMicrotask(() => drain())
  const { id: taskId } = h.taskManager.create({
    objective: '编写一个快速排序',
    ownerId: h.ownerId,
    sessionId: h.sessionId,
    runner: async () => ({
      content: '快速排序已实现',
      metadata: {
        presentation: {
          speech: '快速排序已实现，使用了经典的分治策略。',
          inline: {
            title: '快速排序实现',
            format: 'code',
            content: 'function quicksort(arr) {\n  if (arr.length <= 1) return arr\n  const [pivot, ...rest] = arr\n  return [...quicksort(rest.filter(x => x < pivot)), pivot, ...quicksort(rest.filter(x => x >= pivot))]\n}',
          },
        },
      },
    }),
  })

  await h.taskManager.wait(taskId)
  await flush()

  // --- inline path: timeline.inline sent via WebSocket ---
  const inlineMsg = h.wsMessages.find(m => m.type === 'timeline.inline')
  assert.ok(inlineMsg, 'timeline.inline message should be sent')
  assert.equal(inlineMsg.item.taskId, taskId)
  assert.equal(inlineMsg.item.title, '快速排序实现')
  assert.equal(inlineMsg.item.format, 'code')
  assert.match(inlineMsg.item.content, /function quicksort/)
  assert.match(inlineMsg.item.content, /pivot/)

  // --- speech path: injectResult called exactly once ---
  assert.equal(h.injectCalls.length, 1, 'injectResult must be called exactly once')
  assert.match(h.injectCalls[0].text, /\[COMPLETE\]/)
  assert.match(h.injectCalls[0].text, /快速排序已实现/)
  assert.equal(h.injectCalls[0].origin, 'announcement')

  // --- speak should not be used (announcement uses injectResult) ---
  assert.equal(h.speakCalls.length, 0, 'speak should not be called for announcements')

  // --- no duplicate timeline.inline ---
  const inlineCount = h.wsMessages.filter(m => m.type === 'timeline.inline').length
  assert.equal(inlineCount, 1, 'timeline.inline must not be duplicated')

  h.announcements.close()
})

test('task with inline=null: no timeline.inline sent, injectResult still called once', async () => {
  const h = createDeliveryHarness()

  const { id: taskId } = h.taskManager.create({
    objective: '查询天气',
    ownerId: h.ownerId,
    sessionId: h.sessionId,
    runner: async () => ({
      content: '今天晴，25度。',
      metadata: {
        presentation: {
          speech: '今天晴，25度。',
          inline: null,
        },
      },
    }),
  })

  await h.taskManager.wait(taskId)
  await flush()

  // No inline content → no timeline.inline message
  const inlineMsg = h.wsMessages.find(m => m.type === 'timeline.inline')
  assert.equal(inlineMsg, undefined, 'no timeline.inline when inline is null')

  // Speech still delivered via announcement system
  assert.equal(h.injectCalls.length, 1, 'injectResult called once for speech-only task')
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
      metadata: {
        presentation: {
          speech: '快速排序已实现。',
          inline: {
            title: '代码',
            format: 'code',
            content: 'function qs() {}',
          },
        },
      },
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

  // timeline.inline also sent exactly once
  const inlineCount = h.wsMessages.filter(m => m.type === 'timeline.inline').length
  assert.equal(inlineCount, 1, 'timeline.inline must not be duplicated')

  h.announcements.close()
})

test('multiple programming tasks: each gets one inline and one injectResult', async () => {
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
      metadata: {
        presentation: {
          speech: '冒泡排序已实现。',
          inline: { title: '冒泡排序', format: 'code',
            content: 'function bubble(arr) { /* bubble sort */ }' },
        },
      },
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
      metadata: {
        presentation: {
          speech: '归并排序已实现。',
          inline: { title: '归并排序', format: 'code',
            content: 'function merge(arr) { /* merge sort */ }' },
        },
      },
    }),
  })

  await h.taskManager.wait(id2)
  await flush()

  // --- Two timeline.inline messages, one per task ---
  const inlineMsgs = h.wsMessages.filter(m => m.type === 'timeline.inline')
  assert.equal(inlineMsgs.length, 2, 'two inline messages for two tasks')
  assert.match(inlineMsgs[0].item.content, /bubble/)
  assert.match(inlineMsgs[1].item.content, /merge/)

  // --- Two injectResult calls, one per task ---
  assert.equal(h.injectCalls.length, 2, 'two injectResult calls for two tasks')
  assert.match(h.injectCalls[0].text, /冒泡排序/)
  assert.match(h.injectCalls[1].text, /归并排序/)

  h.announcements.close()
})

test('failed task: no inline shown, error delivered via injectResult once', async () => {
  const h = createDeliveryHarness()

  // Runner throws — TaskManager sets task.error, resultMetadata stays null,
  // so no inline content is available for timeline.inline.
  const { id: taskId } = h.taskManager.create({
    objective: '编写一个快速排序',
    ownerId: h.ownerId,
    sessionId: h.sessionId,
    runner: async () => { throw new Error('syntax error in generated code') },
  })

  await h.taskManager.wait(taskId)
  await flush()

  // Failed tasks have no resultMetadata → no timeline.inline
  const inlineMsg = h.wsMessages.find(m => m.type === 'timeline.inline')
  assert.equal(inlineMsg, undefined, 'no timeline.inline for failed task')

  // But the error is still announced via injectResult
  assert.equal(h.injectCalls.length, 1, 'injectResult called once for failed task')
  assert.match(h.injectCalls[0].text, /\[COMPLETE\]/)
  assert.match(h.injectCalls[0].text, /syntax error/)

  h.announcements.close()
})
