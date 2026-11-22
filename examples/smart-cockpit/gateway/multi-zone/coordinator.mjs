import { randomUUID } from 'node:crypto'

export const ZONES = Object.freeze({ driver: '主驾', passenger: '副驾', rearLeft: '左后', rearRight: '右后' })

// One instance per authenticated GCP connection. ASR events and text simulations
// share this barrier; only complete batches ever reach the decision model.
export class MultiZoneCoordinator {
  constructor({ submit, collect, publish, beforeSubmit, mergeMs = 300, timeoutMs = 30_000 }) {
    Object.assign(this, { submit, collect, publish, beforeSubmit, mergeMs, timeoutMs })
    this.batch = null
    this.history = []
    this.seen = new Set()
    this.closed = false
    this.mergeTimer = null
    this.deadlineTimer = null
  }

  snapshot() {
    return { batch: this.batch && structuredClone(this.batch), history: structuredClone(this.history) }
  }

  changed() { this.publish(this.snapshot()) }

  start(zone, id) {
    if (this.closed || !ZONES[zone] || !id || this.seen.has(`${zone}:${id}`)) return
    if (!this.batch) {
      this.batch = { id: randomUUID(), status: 'collecting', entries: [], text: '', error: '', startedAt: Date.now() }
      this.collect(true)
      this.deadlineTimer = setTimeout(() => this.fail('等待音区结束或最终识别超时，请重新发送'), this.timeoutMs)
      this.deadlineTimer.unref?.()
    }
    clearTimeout(this.mergeTimer)
    this.mergeTimer = null
    this.seen.add(`${zone}:${id}`)
    if (this.seen.size > 2048) this.seen.delete(this.seen.values().next().value)
    this.batch.entries.push({ zone, id, label: ZONES[zone], startedAt: Date.now(), ended: false, final: false, text: '' })
    this.batch.status = 'collecting'
    this.changed()
  }

  update(zone, id, patch) {
    const entry = this.batch?.entries.find(row => row.zone === zone && row.id === id)
    if (!entry || this.closed) return
    if (entry.final && Object.hasOwn(patch, 'text')) return
    Object.assign(entry, patch)
    this.check()
  }

  end(zone, id) { this.update(zone, id, { ended: true }) }
  discard(zone, id) {
    if (!this.batch) return
    this.batch.entries = this.batch.entries.filter(entry => entry.zone !== zone || entry.id !== id)
    if (!this.batch.entries.length) return this.fail('本轮未包含有效请求')
    this.check()
  }
  partial(zone, id, text) { this.update(zone, id, { text: String(text || '') }) }
  final(zone, id, text) {
    const value = String(text || '').trim()
    if (!this.batch?.entries.some(row => row.zone === zone && row.id === id)) return
    if (!value) return this.fail(`${ZONES[zone]}没有识别到有效文字，请重新发送`)
    this.update(zone, id, { text: value, final: true })
  }

  text(rows, submissionId = randomUUID()) {
    for (const row of rows) this.start(row.zone, `${submissionId}:${row.zone}`)
    for (const row of rows) {
      const id = `${submissionId}:${row.zone}`
      this.end(row.zone, id)
      this.final(row.zone, id, row.text)
    }
  }

  check() {
    if (!this.batch) return
    const complete = this.batch.entries.every(row => row.ended && row.final)
    this.batch.status = complete ? 'merging' : 'collecting'
    this.changed()
    if (complete && !this.mergeTimer) {
      this.mergeTimer = setTimeout(() => this.flush(), this.mergeMs)
      this.mergeTimer.unref?.()
    }
  }

  async flush() {
    if (!this.batch || this.closed || this.flushing || !this.batch.entries.every(row => row.ended && row.final)) return
    const batch = this.batch
    this.flushing = true
    try {
      if (this.beforeSubmit) {
        batch.status = 'waiting_realtime'
        this.changed()
        await this.beforeSubmit()
      }
      if (this.closed || this.batch !== batch) return
      if (!batch.entries.every(row => row.ended && row.final)) return
      batch.text = batch.entries.map(row => `【${row.label}】${row.text}`).join('\n')
      clearTimeout(this.deadlineTimer)
      clearTimeout(this.mergeTimer)
      this.mergeTimer = null
      this.batch = null
      this.collect(false)
      try {
        this.submit([{ type: 'text', text: batch.text }])
        batch.status = 'submitted'
      } catch (error) {
        batch.status = 'failed'
        batch.error = error.message
      }
      this.history = [batch, ...this.history].slice(0, 12)
      this.changed()
    } catch (error) {
      if (this.batch === batch) this.fail(error.message)
    } finally {
      this.flushing = false
      if (this.batch === batch && !this.closed) {
        clearTimeout(this.mergeTimer)
        this.mergeTimer = null
        this.check()
      }
    }
  }

  fail(message) {
    if (!this.batch || this.closed) return
    clearTimeout(this.mergeTimer)
    clearTimeout(this.deadlineTimer)
    this.mergeTimer = null
    const batch = { ...this.batch, status: 'failed', error: message }
    this.batch = null
    this.collect(false)
    this.history = [batch, ...this.history].slice(0, 12)
    this.changed()
  }

  close() {
    if (this.closed) return
    this.fail('本轮收集已取消')
    this.closed = true
    clearTimeout(this.mergeTimer)
    clearTimeout(this.deadlineTimer)
  }
}
