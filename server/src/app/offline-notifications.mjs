import { TaskDomainEvent } from '../task/task-events.mjs'

export function installOfflineNotifications({
  taskManager,
  parentPort,
  delayMs,
  setTimer = setTimeout,
} = {}) {
  return taskManager.subscribe(event => {
    if (event.type !== TaskDomainEvent.NOTIFICATION_PENDING) return
    const timer = setTimer(() => {
      const current = taskManager.get(event.task.id, {
        ownerId: event.ownerId,
      })
      if (!current) return
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
