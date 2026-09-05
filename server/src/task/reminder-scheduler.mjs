import { TaskDomainEvent } from './task-events.mjs'
import { TaskStatus, transitionTask } from './task-state.mjs'
import { nextOccurrenceAt, normalizeRecurrence } from './recurrence.mjs'

/**
 * ReminderScheduler — setTimeout-driven scheduler for scheduled tasks.
 *
 * Does not poll. Uses a single setTimeout for the next due task, re-arming
 * after each fire. On restart, overdue tasks are staggered (not replayed
 * simultaneously) to avoid swamping the backend agent.
 *
 * Borrowed from OpenClaw's automation system:
 *   - Overdue rescheduling on restart (stagger instead of replay)
 *   - Per-run wall-clock budget (handled in TaskManager.start)
 *   - Cleanup window before force-fail (handled in TaskManager.start)
 */

export class ReminderScheduler {
  constructor({
    taskManager,
    staggerMs = 30_000,
    logger = null,
  } = {}) {
    this.taskManager = taskManager
    this.staggerMs = staggerMs
    this.logger = logger
    this.timer = null

    // Re-arm whenever a new scheduled task is created or cancelled.
    this.unsubscribe = this.taskManager.subscribe(event => {
      if (
        event.type === TaskDomainEvent.SCHEDULED
        || event.type === TaskDomainEvent.CANCELLED
      ) {
        this.reschedule()
      }
    })
  }

  start() {
    this.restoreOverdue()
    this.reschedule()
  }

  close() {
    clearTimeout(this.timer)
    this.timer = null
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  /**
   * On restart, overdue tasks are staggered — each fired after an increasing
   * delay rather than all at once. This keeps model/tool bootstrap work out of
   * a single burst and avoids overwhelming the backend agent.
   */
  restoreOverdue() {
    const now = Date.now()
    const overdue = [...this.taskManager.tasks.values()]
      .filter(t => t.status === 'scheduled' && t.schedule?.at <= now)
      .sort((a, b) => (a.schedule?.at || 0) - (b.schedule?.at || 0))

    if (!overdue.length) return
    this.logger?.info?.('reminder.restore_overdue', {
      count: overdue.length,
      staggerMs: this.staggerMs,
    })

    overdue.forEach((task, index) => {
      const delay = index * this.staggerMs
      const timer = setTimeout(() => {
        if (!this.fireTask(task)) return
        this.taskManager.persistDeferred()
        this.taskManager.drain()
      }, delay)
      timer.unref?.()
    })
  }

  fireTask(task, now = Date.now()) {
    if (task.status !== 'scheduled') return false
    transitionTask(task, TaskStatus.QUEUED)
    const recurrence = normalizeRecurrence(task.schedule?.recurrence)
    const nextAt = nextOccurrenceAt(
      task.schedule?.at,
      recurrence,
      {
        now,
        timeZone: task.schedule?.timeZone,
      },
    )
    if (nextAt) this.scheduleNext(task, nextAt, recurrence)
    this.taskManager.emit(TaskDomainEvent.SCHEDULED_FIRED, task)
    return true
  }

  scheduleNext(task, at, recurrence) {
    const runner = typeof task.runner === 'function'
      ? task.runner
      : task.kind === 'scheduled_task'
        ? this.taskManager.scheduledTaskRunner
        : null
    const next = this.taskManager.createScheduled({
      objective: task.objective,
      ownerId: task.ownerId,
      sessionId: task.sessionId,
      turnId: task.turnId,
      schedule: {
        at,
        recurrence,
        timeZone: task.schedule?.timeZone,
      },
      type: task.kind === 'scheduled_task' ? 'task' : 'reminder',
      timeoutMs: task.timeoutMs,
      runner,
    })
    this.logger?.debug?.('reminder.rescheduled', {
      taskId: task.id,
      nextTaskId: next.id,
      recurrence,
      executeAt: new Date(at).toISOString(),
    })
    return next
  }

  /**
   * Register a single setTimeout for the next due scheduled task.
   * Called after every create, fire, or cancel.
   */
  reschedule() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const now = Date.now()
    const next = [...this.taskManager.tasks.values()]
      .filter(t => t.status === 'scheduled' && t.schedule?.at > now)
      .map(t => t.schedule.at)
      .sort((a, b) => a - b)[0]
    if (!next) return
    const delay = next - now
    this.timer = setTimeout(() => this.fire(), delay)
    this.timer.unref?.()
  }

  /**
   * Fire all due scheduled tasks: status scheduled → queued, then drain.
   */
  fire(now = Date.now()) {
    let fired = 0
    for (const task of this.taskManager.tasks.values()) {
      if (task.status === 'scheduled' && task.schedule?.at <= now) {
        fired += this.fireTask(task, now) ? 1 : 0
      }
    }
    if (fired) {
      this.taskManager.persistDeferred()
      this.taskManager.drain()
    }
    this.reschedule()
  }
}
