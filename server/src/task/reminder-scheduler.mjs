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
    this.taskManager.subscribe(event => {
      if (event.type === 'task.scheduled' || event.type === 'task.cancelled') {
        this.reschedule()
      }
    })
  }

  start() {
    this.restoreOverdue()
    this.reschedule()
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
        if (task.status !== 'scheduled') return
        task.status = 'queued'
        this.taskManager.emit('task.scheduled.fired', task)
        this.taskManager.persistDeferred()
        this.taskManager.drain()
      }, delay)
      timer.unref?.()
    })
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
  fire() {
    const now = Date.now()
    let fired = 0
    for (const task of this.taskManager.tasks.values()) {
      if (task.status === 'scheduled' && task.schedule?.at <= now) {
        task.status = 'queued'
        // Phase 3: recurrence handling (create next cycle's new scheduled task)
        fired += 1
      }
    }
    if (fired) {
      this.taskManager.persistDeferred()
      this.taskManager.drain()
    }
    this.reschedule()
  }
}
