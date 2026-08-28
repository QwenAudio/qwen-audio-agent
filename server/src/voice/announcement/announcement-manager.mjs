import { randomUUID } from 'node:crypto'
import { createAgentDelivery } from '../../delivery/agent-delivery.mjs'
import { RealtimeAgentDeliveryRuntime } from '../realtime-agent-delivery-runtime.mjs'

export class AnnouncementManager {
  constructor({
    getFrontend,
    deliveryRuntime = null,
    isDeliveryBlocked,
    announceIntoContext = true,
    resultContextMaxChars = 6000,
    maxBatchItems = 8,
    batchWindowMs = 120,
    retryBaseMs = 1000,
    retryMaxMs = 10000,
    acknowledgementTimeoutMs = 120000,
    maxRetryAttempts = 8,
    leaseRenewIntervalMs = 20000,
    createTurnId = () => `gateway_${randomUUID().replaceAll('-', '')}`,
    onDelivered = () => {},
    onLeaseRenew = () => {},
    onRelease = () => {},
    onError = () => {},
  }) {
    this.getFrontend = getFrontend
    this.isDeliveryBlocked = isDeliveryBlocked || (() => false)
    this.deliveryRuntime = deliveryRuntime || new RealtimeAgentDeliveryRuntime({
      getFrontend,
      isDeliveryBlocked: this.isDeliveryBlocked,
    })
    this.announceIntoContext = announceIntoContext
    this.resultContextMaxChars = resultContextMaxChars
    this.maxBatchItems = maxBatchItems
    this.batchWindowMs = batchWindowMs
    this.retryBaseMs = retryBaseMs
    this.retryMaxMs = retryMaxMs
    this.acknowledgementTimeoutMs = acknowledgementTimeoutMs
    this.maxRetryAttempts = maxRetryAttempts
    this.leaseRenewIntervalMs = leaseRenewIntervalMs
    this.createTurnId = createTurnId
    this.onDelivered = onDelivered
    this.onLeaseRenew = onLeaseRenew
    this.onRelease = onRelease
    this.onError = onError
    this.pending = new Map()
    this.activeBatch = null
    this.delivering = false
    this.deliveryGeneration = 0
    this.sequence = 0
    this.retryCount = 0
    this.deliveryTimer = null
    this.retryTimer = null
    this.acknowledgementTimer = null
    this.leaseRenewTimer = null
    this.closed = false
  }

  has(taskId) {
    return this.pending.has(taskId)
  }

  queue(taskId, announcement) {
    this.pending.set(taskId, {
      ...announcement,
      taskId,
      sequence: ++this.sequence,
    })
    this.scheduleDelivery(this.batchWindowMs)
  }

  completed(task) {
    this.queue(task.id, {
      event: 'task.completed',
      status: 'completed',
      objective: task.objective,
      result: task.result,
      completedAt: task.completedAt,
    })
  }

  failed(task) {
    this.queue(task.id, {
      event: 'task.failed',
      status: 'failed',
      objective: task.objective,
      error: task.error,
      completedAt: task.completedAt,
    })
  }

  remove(taskId) {
    this.pending.delete(taskId)
    if (this.activeBatch?.taskIds.includes(taskId)) {
      this.activeBatch.acknowledged.add(taskId)
    }
    this.finishAcknowledgedBatch()
  }

  confirm(taskId) {
    const tracked = this.pending.has(taskId) || this.activeBatch?.taskIds.includes(taskId)
    this.remove(taskId)
    if (tracked) this.onDelivered([taskId])
  }

  confirmMany(taskIds = []) {
    taskIds.filter(Boolean).forEach(taskId => this.confirm(taskId))
  }

  dismissActive() {
    this.confirmMany(this.activeBatch?.taskIds || [])
  }

  retryMany(taskIds = []) {
    if (
      !this.activeBatch
      || !taskIds.some(taskId => this.activeBatch.taskIds.includes(taskId))
    ) return
    this.activeBatch.responseCompleted = false
    this.activeBatch.retryRequested = true
    this.clearAcknowledgementTimeout()
    this.clearRetry()
    if (!this.delivering) {
      this.activeBatch.retryRequested = false
      this.scheduleRetry()
    }
  }

  finishAcknowledgedBatch() {
    if (
      !this.activeBatch
      || !this.activeBatch.taskIds.every(taskId => (
        this.activeBatch.acknowledged.has(taskId)
      ))
    ) return
    this.activeBatch = null
    this.retryCount = 0
    this.clearRetry()
    this.clearAcknowledgementTimeout()
    this.clearLeaseRenewal()
    if (!this.delivering && this.pending.size) this.scheduleDelivery(0)
  }

  clearDelivery() {
    clearTimeout(this.deliveryTimer)
    this.deliveryTimer = null
  }

  clearRetry() {
    clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  clearAcknowledgementTimeout() {
    clearTimeout(this.acknowledgementTimer)
    this.acknowledgementTimer = null
  }

  clearLeaseRenewal() {
    clearInterval(this.leaseRenewTimer)
    this.leaseRenewTimer = null
  }

  ensureLeaseRenewal() {
    if (this.leaseRenewTimer || !this.activeBatch) return
    this.onLeaseRenew(this.activeBatch.taskIds)
    this.leaseRenewTimer = setInterval(() => {
      if (!this.activeBatch) {
        this.clearLeaseRenewal()
        return
      }
      this.onLeaseRenew(this.activeBatch.taskIds)
    }, this.leaseRenewIntervalMs)
    this.leaseRenewTimer.unref?.()
  }

  scheduleAcknowledgementTimeout() {
    this.clearAcknowledgementTimeout()
    this.acknowledgementTimer = setTimeout(() => {
      this.acknowledgementTimer = null
      if (!this.activeBatch?.responseCompleted) return
      // response.done means generation finished, not that the client finished
      // playing it. Long or queued desktop audio may legitimately exceed the
      // acknowledgement window. Never create a second spoken response while
      // the first one is still queued, playing, or blocked by active speech.
      if (this.isDeliveryBlocked()) {
        this.scheduleAcknowledgementTimeout()
        return
      }
      this.activeBatch.responseCompleted = false
      this.activeBatch.retryRequested = true
      if (!this.delivering) {
        this.activeBatch.retryRequested = false
        this.scheduleRetry()
      }
    }, this.acknowledgementTimeoutMs)
    this.acknowledgementTimer.unref?.()
  }

  abandonActiveBatch() {
    const taskIds = this.activeBatch?.taskIds || []
    taskIds.forEach(taskId => this.pending.delete(taskId))
    this.activeBatch = null
    this.retryCount = 0
    this.clearRetry()
    this.clearAcknowledgementTimeout()
    this.clearLeaseRenewal()
    if (taskIds.length) this.onRelease(taskIds)
    if (!this.delivering && this.pending.size) this.scheduleDelivery(0)
  }

  scheduleDelivery(delay = 0) {
    if (
      this.closed
      || this.deliveryTimer
      || this.retryTimer
      || this.activeBatch
      || !this.pending.size
    ) return
    this.deliveryTimer = setTimeout(() => {
      this.deliveryTimer = null
      this.deliver()
    }, Math.max(0, delay))
    this.deliveryTimer.unref?.()
  }

  scheduleRetry() {
    if (this.closed || !this.activeBatch || this.retryTimer) return
    if (this.retryCount >= this.maxRetryAttempts) {
      this.abandonActiveBatch()
      return
    }
    this.retryCount += 1
    const delay = Math.min(
      this.retryMaxMs,
      this.retryBaseMs * (2 ** Math.min(this.retryCount - 1, 4)),
    )
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.deliver()
    }, delay)
    this.retryTimer.unref?.()
  }

  createBatch() {
    const pending = [...this.pending.values()]
      .sort((a, b) => a.sequence - b.sequence)
    if (!pending.length) return null
    const queued = []
    for (const item of pending) {
      const candidate = [...queued, item]
      const candidateText = formatWorkResults(
        this.batchAnnouncements(candidate),
      )
      if (
        queued.length
        && (
          queued.length >= this.maxBatchItems
          || Array.from(candidateText).length > this.resultContextMaxChars
        )
      ) break
      queued.push(item)
    }
    const announcements = this.batchAnnouncements(queued)
    return {
      announcements,
      // Only events actually represented in this bounded model input may be
      // acknowledged when playback ends. Remaining events stay pending.
      taskIds: queued.map(item => item.taskId),
      deliveryTurnId: this.createTurnId(),
      contextInjected: false,
      responseCompleted: false,
      retryRequested: false,
      acknowledged: new Set(),
    }
  }

  batchAnnouncements(queued) {
    return queued
  }

  async deliver() {
    if (this.closed || this.delivering) return
    if (this.isDeliveryBlocked()) {
      // Playback completion normally flushes the queue again. Keep a delayed
      // self-wakeup as well: a throttled renderer or a lost playback receipt
      // must not leave a completed task parked in "replying" forever.
      this.scheduleDelivery(this.retryBaseMs)
      return
    }
    const frontend = this.getFrontend()
    if (!frontend?.ready) {
      if (!this.activeBatch) this.activeBatch = this.createBatch()
      this.ensureLeaseRenewal()
      this.scheduleRetry()
      return
    }
    if (!this.activeBatch) this.activeBatch = this.createBatch()
    const batch = this.activeBatch
    if (!batch) return
    const deliveryGeneration = this.deliveryGeneration
    this.ensureLeaseRenewal()
    this.delivering = true
    try {
      const eventText = truncateResult(
        formatWorkResults(batch.announcements),
        this.resultContextMaxChars,
      )
      const context = {
        turnId: batch.deliveryTurnId,
        taskId: batch.taskIds.length === 1 ? batch.taskIds[0] : null,
        taskIds: batch.taskIds,
      }
      const outcome = this.announceIntoContext
        ? await this.deliveryRuntime.deliver(createAgentDelivery({
            id: `task_result_${batch.deliveryTurnId}`,
            mode: 'respond',
            origin: 'announcement',
            text: eventText,
            correlation: context,
          }), { injectContext: !batch.contextInjected })
        : await frontend.speak(eventText, 'announcement', context)
      if (
        this.deliveryGeneration !== deliveryGeneration
        || this.activeBatch !== batch
      ) return
      if (outcome?.contextInjected) batch.contextInjected = true
      if (outcome?.completed) {
        // Realtime has generated the response, but the client may still have it
        // queued behind earlier audio. Delivery is confirmed only when the
        // client reports that playback has actually started.
        batch.responseCompleted = true
        this.scheduleAcknowledgementTimeout()
      } else if (this.activeBatch) {
        this.scheduleRetry()
      }
    } catch (error) {
      try {
        this.onError(error)
      } catch {
        // Diagnostics must never break announcement recovery.
      }
      if (
        this.deliveryGeneration === deliveryGeneration
        && this.activeBatch === batch
      ) this.scheduleRetry()
    } finally {
      if (this.deliveryGeneration === deliveryGeneration) {
        this.delivering = false
        this.finishAcknowledgedBatch()
        if (this.activeBatch?.retryRequested) {
          this.activeBatch.retryRequested = false
          this.scheduleRetry()
        }
        if (!this.activeBatch && this.pending.size) this.scheduleDelivery(0)
      }
    }
  }

  flush() {
    if (this.isDeliveryBlocked()) return
    this.clearDelivery()
    this.deliver()
  }

  pause() {
    const taskIds = new Set([
      ...this.pending.keys(),
      ...(this.activeBatch?.taskIds || []),
    ])
    this.clearDelivery()
    this.clearRetry()
    this.clearAcknowledgementTimeout()
    this.clearLeaseRenewal()
    this.deliveryGeneration += 1
    this.pending.clear()
    this.activeBatch = null
    this.delivering = false
    this.retryCount = 0
    if (taskIds.size) this.onRelease([...taskIds])
  }

  close() {
    this.closed = true
    this.pause()
  }
}

export function formatWorkResults(announcements) {
  const blocks = announcements.map(item => [
    `task_id: ${item.taskId}`,
    `状态: ${item.status}`,
    item.objective ? `工作: ${item.objective}` : '',
    item.status === 'completed'
      ? `结果: ${String(item.result || '').trim()}`
      : `错误: ${String(item.error || '').trim()}`,
  ].filter(Boolean).join('\n'))
  return [
    '以下是你先前异步执行工作的最终更新，不是用户的新请求。请作为自己的工作结果自然告知用户，不要提后台 Agent、协议或 Task，也不要读出 task_id。',
    ...blocks.map(block => `\n${block}`),
  ].join('\n')
}

export function truncateResult(value, maxChars) {
  const text = String(value || '').trim()
  const limit = Math.max(1, Number(maxChars) || 1)
  const characters = Array.from(text)
  if (characters.length <= limit) return text
  const suffix = '\n…（事件内容过长，已截断；完整结果仍保留在任务记录中）'
  const suffixLength = Array.from(suffix).length
  if (limit <= suffixLength) return characters.slice(0, limit).join('')
  return `${characters.slice(0, limit - suffixLength).join('')}${suffix}`
}
