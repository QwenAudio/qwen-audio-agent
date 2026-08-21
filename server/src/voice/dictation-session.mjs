import { randomUUID } from 'node:crypto'

import {
  CommitReceipts,
  parseFinalSegment,
  textFingerprint,
} from '../../../shared/dictation-contract.mjs'
import { containsSensitiveMemory } from '../conversation/memory-policy.mjs'

const ACTIVE_STATES = new Set([
  'starting', 'listening', 'transcribing', 'editing', 'ready-to-send',
])
const ACCEPTING_STATES = new Set(['listening', 'transcribing', 'editing', 'ready-to-send'])
const TERMINAL_STATES = new Set(['cancelled', 'error', 'stopped'])

function explicitCorrection(text) {
  const source = String(text || '').trim()
  const chinese = source.match(/(?:^|[。！？.!?]\s*)纠正长期事实\s*[：:]\s*(.+?)\s+改为\s+(.+?)[。.!]?$/u)
  if (chinese) return { oldText: chinese[1].trim(), newText: chinese[2].trim() }
  const english = source.match(/(?:^|[.!?]\s*)correct long-term fact\s*:\s*(.+?)\s+to\s+(.+?)[.]?$/iu)
  if (english) return { oldText: english[1].trim(), newText: english[2].trim() }
  return null
}

function deterministicEdit(text) {
  const source = String(text || '').trim()
  let match = source.match(/^replace\s+(.+?)\s+with\s+(.+)$/iu)
  if (match) return { from: match[1].trim(), to: match[2].trim() }
  match = source.match(/^delete\s+(.+)$/iu)
  if (match) return { from: match[1].trim(), to: '' }
  match = source.match(/^把\s*(.+?)\s*改(?:成|为)\s*(.+)$/u)
  if (match) return { from: match[1].trim(), to: match[2].trim() }
  match = source.match(/^删除\s*(.+)$/u)
  if (match) return { from: match[1].trim(), to: '' }
  return null
}

export class DictationSession {
  constructor({
    enabled = false,
    ownerId = '',
    createTranscriber = null,
    send = () => {},
    memoryService = null,
    memoryAudit = null,
    timeoutMs = 45_000,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    id = randomUUID,
  } = {}) {
    this.enabled = enabled
    this.ownerId = ownerId
    this.createTranscriber = createTranscriber
    this.send = send
    this.memoryService = memoryService
    this.memoryAudit = memoryAudit
    this.timeoutMs = timeoutMs
    this.setTimer = setTimer
    this.clearTimer = clearTimer
    this.id = id
    this.receipts = new CommitReceipts()
    this.timer = null
    this.inputSuspended = false
    this.state = 'idle'
    this.sequence = 0
    this.revision = 0
    this.text = ''
    this.partial = ''
    this.pendingCommit = null
    this.lastRange = null
    this.continuous = true
    this.transcriber = null
  }

  snapshot() {
    return {
      state: this.state,
      revision: this.revision,
      partial: this.partial,
      pendingCommit: this.pendingCommit ? { ...this.pendingCommit } : null,
      inputSuspended: this.inputSuspended,
    }
  }

  _armTimeout() {
    if (this.timer) this.clearTimer(this.timer)
    this.timer = null
    if (!ACTIVE_STATES.has(this.state)) return
    this.timer = this.setTimer(() => {
      if (!ACTIVE_STATES.has(this.state)) return
      this._fail('听写已超时，请重新开始')
    }, this.timeoutMs)
  }

  _transition(state, details = {}) {
    this.state = state
    this._armTimeout()
    this.send({ type: 'dictation.state', state, ...details })
  }

  _clearTransient({ close = false } = {}) {
    this.partial = ''
    this.pendingCommit = null
    this.lastRange = null
    if (this.timer) this.clearTimer(this.timer)
    this.timer = null
    if (close) this.transcriber?.close?.()
  }

  _fail(message) {
    this._clearTransient({ close: true })
    this._transition('error', { message: String(message || '听写失败') })
    return false
  }

  _providerCallbacks() {
    return {
      ready: () => {
        if (this.state !== 'starting') return false
        this._transition('listening')
        return true
      },
      partial: text => {
        if (!ACCEPTING_STATES.has(this.state)) return false
        this.partial = String(text || '')
        this.sequence += 1
        this._transition('transcribing')
        this.send({
          type: 'dictation.partial', text: this.partial,
          revision: this.revision, seq: this.sequence,
        })
        return true
      },
      final: text => this._acceptFinal(text),
      error: error => this._fail(error?.message || error),
    }
  }

  _acceptFinal(value) {
    if (!ACCEPTING_STATES.has(this.state)) return false
    const edit = deterministicEdit(value)
    if (edit) {
      const recent = this.lastRange
        ? this.text.slice(this.lastRange.start, this.lastRange.end)
        : ''
      const first = recent.indexOf(edit.from)
      if (
        !edit.from || first < 0
        || recent.indexOf(edit.from, first + edit.from.length) >= 0
      ) {
        this._transition('listening', {
          message: '编辑目标不在最近口述范围内，或匹配不唯一',
        })
        return false
      }
      const revision = this.revision
      const absolute = this.lastRange.start + first
      this.text = this.text.slice(0, absolute) + edit.to
        + this.text.slice(absolute + edit.from.length)
      this.lastRange.end += edit.to.length - edit.from.length
      this.revision += 1
      this.sequence += 1
      this.send({
        type: 'dictation.operation', operation: 'replace',
        from: edit.from, to: edit.to, revision, seq: this.sequence,
      })
      this._transition('listening')
      return true
    }
    const parsed = parseFinalSegment(value)
    this.partial = ''
    if (parsed.text) {
      this.sequence += 1
      const start = this.text.length
      this.text += parsed.text
      this.lastRange = { start, end: this.text.length }
      this.send({
        type: 'dictation.final', text: parsed.text,
        revision: this.revision, seq: this.sequence,
      })
      this.revision += 1
    }
    if (!parsed.send) {
      this._transition('listening')
      return true
    }
    const commitId = this.id()
    this.pendingCommit = {
      commitId,
      revision: this.revision,
      fingerprint: textFingerprint(this.text),
      text: this.text,
    }
    this._transition('ready-to-send')
    this.send({
      type: 'dictation.commit.request',
      commitId,
      revision: this.pendingCommit.revision,
      fingerprint: this.pendingCommit.fingerprint,
    })
    return true
  }

  _start(event) {
    if (!this.enabled || this.inputSuspended || typeof this.createTranscriber !== 'function') {
      return false
    }
    this._clearTransient({ close: true })
    this.revision = Number.isInteger(event.revision) ? event.revision : 0
    this.text = String(event.text || '')
    this.sequence = 0
    this.lastRange = null
    this.continuous = event.continuous !== false
    this.transcriber = this.createTranscriber()
    if (!this.transcriber) return this._fail('听写供应商不可用')
    this._transition('starting')
    this.transcriber.start?.(this._providerCallbacks())
    // Adapters may be synchronous and omit a ready callback.
    if (this.state === 'starting') this._transition('listening')
    return true
  }

  _commit(event) {
    const pending = this.pendingCommit
    if (
      this.state !== 'ready-to-send'
      || !pending
      || event.submitted !== true
      || event.commitId !== pending.commitId
      || Number(event.revision) !== pending.revision
      || event.fingerprint !== pending.fingerprint
      || !this.receipts.accept(event.commitId)
    ) return false

    this.pendingCommit = null
    const correction = explicitCorrection(pending.text)
    if (correction) {
      if (containsSensitiveMemory(correction.newText)) {
        this._fail('长期事实纠正包含敏感内容，未写入 Memory')
        return false
      }
      try {
        const result = this.memoryService?.apply(this.ownerId, [{
          document: 'memory',
          edits: [{ old_text: correction.oldText, new_text: correction.newText }],
          append: '',
        }])
        if (result?.changed) {
          this.memoryAudit?.record({
            op: 'dictation_explicit_correction',
            ownerId: this.ownerId,
            changed: result.changed,
          })
        }
      } catch {
        this._fail('长期事实纠正未能精确匹配，Memory 未修改')
        return false
      }
    }
    this.text = ''
    this.revision += 1
    if (this.continuous) this._transition('listening')
    else {
      this._clearTransient({ close: true })
      this._transition('stopped')
    }
    return true
  }

  handle(event = {}) {
    if (!this.enabled) return false
    switch (event.type) {
      case 'dictation.start': return this._start(event)
      case 'dictation.audio.append':
        if (!ACCEPTING_STATES.has(this.state)) return false
        this._armTimeout()
        this.transcriber?.append?.(event.audio)
        return true
      case 'dictation.pause':
        if (!ACCEPTING_STATES.has(this.state)) return false
        this.transcriber?.pause?.()
        this._clearTransient()
        this._transition('paused')
        return true
      case 'dictation.resume':
        if (this.state !== 'paused' || this.inputSuspended) return false
        this.transcriber?.resume?.()
        this._transition('listening')
        return true
      case 'dictation.cancel':
        if (TERMINAL_STATES.has(this.state) || this.state === 'idle') return false
        this._clearTransient({ close: true })
        this._transition('cancelled')
        return true
      case 'dictation.stop':
        if (TERMINAL_STATES.has(this.state) || this.state === 'idle') return false
        this._clearTransient({ close: true })
        this._transition('stopped')
        return true
      case 'dictation.commit.ack': return this._commit(event)
      case 'dictation.context':
        if (!ACCEPTING_STATES.has(this.state)) return false
        if (
          Number(event.expectedRevision) !== this.revision
          || !Number.isInteger(event.revision)
          || event.revision <= this.revision
        ) return false
        this.text = String(event.text || '')
        this.revision = event.revision
        this.lastRange = null
        return true
      default: return false
    }
  }

  suspend(owner = '') {
    this.inputSuspended = true
    if (this.state !== 'idle') {
      this._clearTransient({ close: true })
      this._transition('stopped', { reason: 'input.suspend', owner })
    }
  }

  resumeInput() {
    this.inputSuspended = false
  }

  close() {
    this._clearTransient({ close: true })
    this.state = 'stopped'
  }
}
