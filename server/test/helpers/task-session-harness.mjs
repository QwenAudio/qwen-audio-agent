import { TaskManager } from '../../src/task/task-manager.mjs'
import { SessionTaskCoordinator } from '../../src/orchestration/session-task-coordinator.mjs'
import { createRealtimeTaskPresentation } from '../../src/voice/realtime-task-presentation.mjs'
import { RealtimeAgentDeliveryRuntime } from '../../src/voice/realtime-agent-delivery-runtime.mjs'
import { createTaskAnnouncementRuntime } from '../../src/voice/announcement/task-announcement-runtime.mjs'
import { recordTaskResult } from '../../src/conversation/task-result-projector.mjs'

// Only the model boundary is fake. Tests exercise production task observation,
// claims, presentation, delivery, announcements and result recording together.
export function createDeliveryHarness({
  taskManager = new TaskManager(), ownerId = 'owner-1', sessionId = 'session-1',
  taskAnnouncementFactory = createTaskAnnouncementRuntime,
} = {}) {
  const injectCalls = [], speakCalls = [], contextCalls = [], cancellations = []
  const events = [], errors = [], order = [], records = []
  const state = { ready: true, outputEnabled: true, sleeping: false, waking: false, busy: false, windowBlocked: false }
  const frontend = {
    get ready() { return state.ready },
    async injectDelivery(text, origin, context, options) {
      if (options.shouldRespond && !options.shouldRespond()) return { completed: false }
      order.push(origin)
      injectCalls.push({ text, origin, context, options })
      return { completed: true, contextInjected: true }
    },
    async speak(...args) { speakCalls.push(args); return { completed: true } },
    async appendUserInputContext(parts) { contextCalls.push(parts) },
    cancelResponses(predicate) { cancellations.push(predicate) },
  }
  const conversationSync = {
    record(event) { records.push(event); return null },
    hasEquivalentAssistantSpeech() { return false },
  }
  const deliveryRuntime = new RealtimeAgentDeliveryRuntime({
    getFrontend: () => frontend,
    isDeliveryBlocked: () => !state.ready || !state.outputEnabled || state.sleeping || state.waking,
  })
  const coordinator = new SessionTaskCoordinator({
    taskManager, ownerId, sessionId,
    presentation: createRealtimeTaskPresentation({
      getState: () => state,
      getFrontend: () => frontend,
      deliveryRuntime,
      updateContext: () => order.push('tools'),
      cancelPermission: id => cancellations.push(id),
      taskAnnouncementFactory,
      config: { announcementBatchMs: 0, announcementMaxBatchItems: 1, announcementQuietMs: 100, taskNotificationClaimTtlMs: 60_000 },
      onError: error => errors.push(error),
      onProgressError: error => errors.push(error),
    }),
    onTaskEvent: event => events.push(event),
    onResult: task => recordTaskResult({ conversationSync, ownerId, sessionId, task }),
    onWake: () => {
      order.push('wake')
      state.sleeping = false
      coordinator.announcePendingPermissions()
      coordinator.announcePendingInputs()
      coordinator.claimPendingNotifications()
      coordinator.announcements.results.flush()
    },
  })
  coordinator.start()
  return { coordinator, taskManager, announcements: coordinator.announcements.results, frontend,
    injectCalls, speakCalls, contextCalls, cancellations, events, errors, order, records, state, ownerId, sessionId }
}

export const flush = () => new Promise(resolve => setTimeout(resolve, 20))

export async function startTask(h, options = {}) {
  let emit, complete
  const task = h.taskManager.create({
    ownerId: h.ownerId, sessionId: h.sessionId, objective: 'work', ...options,
    runner: (_objective, { onEvent, signal }) => new Promise((resolve, reject) => {
      emit = onEvent
      complete = resolve
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }),
  })
  await new Promise(resolve => setImmediate(resolve))
  return { task, emit, complete }
}
