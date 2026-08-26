import { progressResponseInstructions } from '../frontend-tools.mjs'

const DEFAULT_INTERVAL_MS = 60_000
const DEFAULT_QUIET_MS = 800
const DEFAULT_RETRY_MS = 1_000

function text(value) {
  return String(value || '').trim()
}

function progressContext(candidate) {
  return {
    taskId: candidate.taskId,
    // A progress update belongs to the live timeline, not the historical turn
    // that originally created the task. taskId preserves the work relation.
    turnId: null,
    taskIds: [candidate.taskId],
    deliverySequence: null,
  }
}

function progressPayload(candidate) {
  return [
    '<background_work_progress>',
    candidate.message,
    '</background_work_progress>',
  ].join('\n')
}

/**
 * Coalesces protocol-level Agent messages into low-frequency spoken updates.
 *
 * This component owns presentation timing only. Task liveness comes from the
 * TaskManager and progress content comes from BackendPort MESSAGE events; it
 * never polls a backend or derives narration from tool activity.
 */
export class ProgressAnnouncementManager {
  constructor({
    getFrontend,
    isDeliveryBlocked = () => false,
    isTaskActive = () => true,
    intervalMs = DEFAULT_INTERVAL_MS,
    quietMs = DEFAULT_QUIET_MS,
    retryMs = DEFAULT_RETRY_MS,
    onError = () => {},
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    this.getFrontend = getFrontend
    this.isDeliveryBlocked = isDeliveryBlocked
    this.isTaskActive = isTaskActive
    this.intervalMs = Math.max(1, Number(intervalMs) || DEFAULT_INTERVAL_MS)
    this.quietMs = Math.max(0, Number(quietMs) || 0)
    this.retryMs = Math.max(1, Number(retryMs) || DEFAULT_RETRY_MS)
    this.onError = onError
    this.now = now
    this.setTimer = setTimer
    this.clearTimer = clearTimer
    this.candidates = new Map()
    this.lastAnnouncedAt = 0
    this.timer = null
    this.delivering = false
    this.closed = false
  }

  offer({ taskId, turnId = null, startedAt = null, message } = {}) {
    const id = text(taskId)
    const content = text(message).slice(-4_000)
    if (!id || !content || this.closed) return
    const timestamp = this.now()
    const previous = this.candidates.get(id)
    this.candidates.set(id, {
      taskId: id,
      turnId,
      startedAt: Number(startedAt) || previous?.startedAt || timestamp,
      firstOfferedAt: previous?.firstOfferedAt || timestamp,
      updatedAt: timestamp,
      notBefore: previous?.notBefore || 0,
      message: content,
      version: (previous?.version || 0) + 1,
    })
    this.schedule()
  }

  remove(taskId) {
    const id = text(taskId)
    this.candidates.delete(id)
    try {
      this.getFrontend?.()?.cancelResponses?.((context, origin) => (
        origin === 'progress' && context?.taskId === id
      ))
    } catch {
      // The realtime frontend may already be closing.
    }
    this.schedule()
  }

  clear() {
    this.candidates.clear()
    try {
      this.getFrontend?.()?.cancelResponses?.((_context, origin) => (
        origin === 'progress'
      ))
    } catch {
      // The realtime frontend may already be closing.
    }
    this.cancelTimer()
  }

  flush() {
    this.schedule()
  }

  close() {
    this.closed = true
    this.clear()
  }

  cancelTimer() {
    if (!this.timer) return
    this.clearTimer(this.timer)
    this.timer = null
  }

  candidateDueAt(candidate) {
    const cadenceDueAt = Math.max(
      candidate.startedAt + this.intervalMs,
      this.lastAnnouncedAt + this.intervalMs,
      candidate.firstOfferedAt,
      candidate.notBefore || 0,
    )
    // Prefer a short natural-text boundary, but cap that debounce so a
    // continuously streaming Agent message cannot postpone speech forever.
    return Math.max(
      cadenceDueAt,
      Math.min(
        candidate.updatedAt + this.quietMs,
        cadenceDueAt + this.quietMs,
      ),
    )
  }

  nextCandidate() {
    for (const [taskId] of this.candidates) {
      if (!this.isTaskActive(taskId)) this.candidates.delete(taskId)
    }
    return [...this.candidates.values()]
      .map(candidate => ({
        candidate,
        dueAt: this.candidateDueAt(candidate),
      }))
      .sort((left, right) => (
        left.dueAt - right.dueAt
        || left.candidate.updatedAt - right.candidate.updatedAt
      ))[0] || null
  }

  schedule() {
    if (this.closed || this.delivering) return
    this.cancelTimer()
    const next = this.nextCandidate()
    if (!next) return
    this.timer = this.setTimer(() => {
      this.timer = null
      this.deliver().catch(error => this.onError(error))
    }, Math.max(0, next.dueAt - this.now()))
    this.timer?.unref?.()
  }

  async deliver() {
    if (this.closed || this.delivering) return
    const next = this.nextCandidate()
    if (!next) return
    const timestamp = this.now()
    if (next.dueAt > timestamp) {
      this.schedule()
      return
    }
    const candidate = next.candidate
    let blocked = true
    try {
      blocked = this.isDeliveryBlocked() === true
    } catch {
      blocked = true
    }
    const frontend = this.getFrontend?.()
    if (blocked || typeof frontend?.injectResult !== 'function') {
      candidate.notBefore = timestamp + this.retryMs
      this.schedule()
      return
    }

    this.delivering = true
    try {
      await frontend.injectResult(
        progressPayload(candidate),
        'progress',
        progressContext(candidate),
        {
          injectContext: true,
          instructions: progressResponseInstructions,
        },
      )
      // A user interruption consumes this low-priority update too. Replaying
      // the same monologue would be more disruptive than omitting it.
      this.lastAnnouncedAt = this.now()
      if (this.candidates.get(candidate.taskId)?.version === candidate.version) {
        this.candidates.delete(candidate.taskId)
      }
    } catch (error) {
      const current = this.candidates.get(candidate.taskId)
      if (current) current.notBefore = this.now() + this.retryMs
      this.onError(error)
    } finally {
      this.delivering = false
      this.schedule()
    }
  }
}
