import { TaskDomainEvent } from '../task/task-events.mjs'
import { isTaskActive } from '../task/task-state.mjs'

export function installOfflineNotifications({
  taskManager,
  parentPort,
  delayMs,
  setTimer = setTimeout,
} = {}) {
  return taskManager.subscribe(event => {
    if (![
      TaskDomainEvent.PROGRESS_CHECK,
      TaskDomainEvent.NOTIFICATION_PENDING,
    ].includes(event.type)) return
    const timer = setTimer(() => {
      const current = taskManager.get(event.task.id, {
        ownerId: event.ownerId,
      })
      if (!current) return
      if (event.type === TaskDomainEvent.PROGRESS_CHECK) {
        if (!isTaskActive(current.status)) return
        parentPort?.postMessage({
          type: 'qwen-audio-agent:offline-notification',
          task: {
            id: current.id,
            objective: current.objective,
            result: event.message,
            status: 'progress',
          },
        })
        return
      }
      if (current.notificationStatus !== 'pending') return
      parentPort?.postMessage({
        type: 'qwen-audio-agent:offline-notification',
        task: {
          id: current.id,
          objective: current.objective,
          result: current.result,
          error: current.error,
          status: current.status,
        },
      })
    }, delayMs)
    timer.unref?.()
  })
}
