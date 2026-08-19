import { randomUUID } from 'node:crypto'
import {
  DICTATION_DEFAULT_TIMEOUT_MS,
  DictationClientEvent,
  DictationServerEvent,
} from '../../../shared/dictation-protocol.mjs'
import {
  applyDraftOperation,
  draftPayloadHash,
  parseDictationIntent,
} from '../../../shared/dictation-draft.mjs'
import { CommitRegistry } from './commit-registry.mjs'

function defaultId(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`
}

function snapshotFrom(event) {
  const text = String(event.text || '')
  const revision = Math.max(0, Number(event.revision) || 0)
  const selectionStart = Math.max(
    0,
    Math.min(text.length, Number(event.selectionStart) || 0),
  )
  const selectionEnd = Math.max(
    selectionStart,
    Math.min(text.length, Number(event.selectionEnd) || selectionStart),
  )
  return { text, selectionStart, selectionEnd, revision }
}

export class DictationSession {
  constructor({
    send,
    createTranscriber,
    rewriteText = null,
    createId = defaultId,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    timeoutMs = DICTATION_DEFAULT_TIMEOUT_MS,
    commitRegistry = new CommitRegistry(),
  } = {}) {
    this.sendEvent = send
    this.createTranscriber = createTranscriber
    this.rewriteText = rewriteText
    this.createId = createId
    this.setTimer = setTimer
    this.clearTimer = clearTimer
    this.timeoutMs = timeoutMs
    this.commitRegistry = commitRegistry
    this.sessionId = ''
    this.state = 'idle'
    this.clientSeq = 0
    this.serverSeq = 0
    this.continuous = true
    this.transcriber = null
    this.timer = null
    this.pendingIntent = null
    this.pendingContext = null
    this.pendingOperation = null
    this.pendingCommit = null
    this.conflictRetries = 0
    this.closed = false
  }

  send(event) {
    this.sendEvent?.({
      ...event,
      sessionId: this.sessionId,
      seq: ++this.serverSeq,
    })
  }

  setState(state) {
    this.state = state
    this.send({ type: DictationServerEvent.STATE, state })
  }

  error(code, message) {
    this.send({
      type: DictationServerEvent.ERROR,
      code,
      message: String(message || code),
    })
  }

  acceptSequence(event) {
    if (!Number.isSafeInteger(event.seq) || event.seq <= this.clientSeq) {
      this.error('seq_conflict', 'Dictation event sequence is not monotonic.')
      return false
    }
    this.clientSeq = event.seq
    return true
  }

  resetTimeout() {
    this.clearTimer(this.timer)
    this.timer = null
    if (this.closed || !['listening', 'transcribing', 'editing'].includes(this.state)) {
      return
    }
    this.timer = this.setTimer(() => this.pauseForTimeout(), this.timeoutMs)
    this.timer?.unref?.()
  }

  pauseForTimeout() {
    if (this.closed || !['listening', 'transcribing', 'editing'].includes(this.state)) {
      return
    }
    this.transcriber?.pause?.()
    this.setState('paused')
    this.clearTimer(this.timer)
    this.timer = null
  }

  async handle(event = {}) {
    if (this.closed) return false
    if (event.type === DictationClientEvent.START) {
      if (this.sessionId && event.sessionId !== this.sessionId) {
        this.error('session_conflict', 'A dictation session is already active.')
        return false
      }
      if (!this.sessionId) this.sessionId = String(event.sessionId || '')
      if (!this.sessionId) {
        this.error('session_required', 'Dictation sessionId is required.')
        return false
      }
      if (!this.acceptSequence(event)) return false
      return this.start(event)
    }
    if (!this.sessionId || event.sessionId !== this.sessionId) {
      this.error('unknown_session', 'Unknown dictation session.')
      return false
    }
    if (!this.acceptSequence(event)) return false
    this.resetTimeout()

    if (event.type === DictationClientEvent.AUDIO_APPEND) {
      if (!['listening', 'transcribing', 'editing'].includes(this.state)) return false
      this.transcriber?.appendAudio?.(event.audio)
      this.resetTimeout()
      return true
    }
    if (event.type === DictationClientEvent.PAUSE) {
      this.transcriber?.pause?.()
      this.setState('paused')
      return true
    }
    if (event.type === DictationClientEvent.RESUME) {
      if (this.state !== 'paused') return false
      this.transcriber?.resume?.()
      this.setState('listening')
      this.resetTimeout()
      return true
    }
    if (event.type === DictationClientEvent.CANCEL) {
      this.cancel()
      return true
    }
    if (event.type === DictationClientEvent.STOP) {
      this.transcriber?.close?.({ finish: true })
      this.clearEphemeral()
      this.setState('paused')
      return true
    }
    if (event.type === DictationClientEvent.CONTEXT) {
      return this.acceptContext(event)
    }
    if (event.type === DictationClientEvent.OPERATION_ACK) {
      return this.acceptOperationAck(event)
    }
    if (event.type === DictationClientEvent.COMMIT_ACK) {
      return this.acceptCommitAck(event)
    }
    return false
  }

  start(event) {
    if (this.state !== 'idle') return false
    this.continuous = event.continuous !== false
    this.setState('starting')
    try {
      this.transcriber = this.createTranscriber({
        onDelta: text => this.onDelta(text),
        onFinal: text => this.onFinal(text),
        onError: error => this.onProviderError(error),
      })
      Promise.resolve(this.transcriber.start({
        locale: String(event.locale || ''),
        continuous: this.continuous,
      })).then(() => {
        if (this.closed || this.state !== 'starting') return
        this.setState('listening')
        this.resetTimeout()
      }).catch(error => {
        if (this.closed || this.state === 'cancelled') return
        this.onProviderError(error)
      })
      return true
    } catch (error) {
      this.onProviderError(error)
      return false
    }
  }

  onDelta(value) {
    if (this.closed || !['listening', 'transcribing'].includes(this.state)) return
    if (this.state !== 'transcribing') this.setState('transcribing')
    this.send({
      type: DictationServerEvent.TRANSCRIPT_DELTA,
      text: String(value || ''),
    })
    this.resetTimeout()
  }

  async onFinal(value) {
    if (this.closed || !['listening', 'transcribing'].includes(this.state)) return
    const text = String(value || '').trim()
    if (!text) {
      this.setState('listening')
      this.resetTimeout()
      return
    }
    this.send({ type: DictationServerEvent.TRANSCRIPT_FINAL, text })
    this.transcriber?.pause?.()
    this.pendingIntent = parseDictationIntent(text)
    this.conflictRetries = 0
    this.setState('editing')
    this.requestContext()
  }

  requestContext() {
    const requestId = this.createId('request')
    this.pendingContext = { requestId }
    this.send({ type: DictationServerEvent.CONTEXT_REQUEST, requestId })
  }

  async acceptContext(event) {
    if (!this.pendingContext || event.requestId !== this.pendingContext.requestId) {
      this.error('context_mismatch', 'Dictation context request does not match.')
      return false
    }
    this.pendingContext = null
    const snapshot = snapshotFrom(event)
    const intent = this.pendingIntent
    if (!intent) return false
    if (intent.kind === 'commit' && !intent.text) {
      this.issueCommit(snapshot)
      return true
    }

    let operation
    if (intent.kind === 'insert' || intent.kind === 'commit') {
      operation = { kind: 'insert', text: intent.text }
    } else if (intent.kind === 'replace') {
      operation = {
        kind: 'replace',
        target: intent.target,
        text: intent.replacement,
      }
    } else if (intent.kind === 'delete') {
      operation = { kind: 'delete', target: intent.target }
    } else if (intent.kind === 'rewrite') {
      if (!this.rewriteText) {
        this.error('rewrite_unavailable', 'Stateless rewrite is not configured.')
        this.setState('error')
        return false
      }
      try {
        operation = {
          kind: 'rewrite',
          text: await this.rewriteText(snapshot.text, intent.instruction),
        }
      } catch (error) {
        this.error('rewrite_failed', error?.message || 'Rewrite failed.')
        this.setState('error')
        return false
      }
    }
    const operationId = this.createId('operation')
    const wireOperation = {
      type: DictationServerEvent.OPERATION,
      operationId,
      baseRevision: snapshot.revision,
      ...operation,
    }
    const expected = applyDraftOperation(snapshot, wireOperation)
    if (!expected.applied) {
      this.error(expected.reason, 'Dictation operation could not be applied.')
      this.setState('error')
      return false
    }
    this.pendingOperation = {
      operationId,
      expected,
      commitAfter: intent.kind === 'commit',
    }
    this.send(wireOperation)
    return true
  }

  async acceptOperationAck(event) {
    const pending = this.pendingOperation
    if (!pending || event.operationId !== pending.operationId) {
      this.error('operation_mismatch', 'Dictation operation acknowledgement does not match.')
      return false
    }
    const applied = event.status === 'applied'
      && Number(event.revision) === pending.expected.revision
    if (!applied) {
      this.pendingOperation = null
      if (this.conflictRetries < 1) {
        this.conflictRetries += 1
        this.requestContext()
        return false
      }
      this.error('revision_conflict', 'Composer changed before dictation could apply.')
      this.setState('error')
      return false
    }
    this.pendingOperation = null
    if (pending.commitAfter) {
      this.issueCommit({
        text: pending.expected.text,
        revision: pending.expected.revision,
      })
    } else {
      this.pendingIntent = null
      this.transcriber?.resume?.()
      this.setState('listening')
      this.resetTimeout()
    }
    return true
  }

  issueCommit(snapshot) {
    const commit = {
      commitId: this.createId('commit'),
      revision: snapshot.revision,
      payloadHash: draftPayloadHash(snapshot.text),
    }
    const accepted = this.commitRegistry.accept(commit)
    if (accepted.status !== 'first') return false
    this.pendingCommit = commit
    this.pendingIntent = null
    this.setState('ready-to-send')
    this.send({ type: DictationServerEvent.COMMIT_REQUEST, ...commit })
    return true
  }

  acceptCommitAck(event) {
    if (!this.pendingCommit || event.commitId !== this.pendingCommit.commitId) {
      // Replayed acknowledgements are harmless and never request another submit.
      return false
    }
    if (event.status !== 'submitted') {
      this.error('commit_rejected', 'Composer did not submit the dictation draft.')
      this.setState('error')
      return false
    }
    this.pendingCommit = null
    if (this.continuous) {
      this.transcriber?.resume?.()
      this.setState('listening')
      this.resetTimeout()
    } else {
      this.transcriber?.close?.({ finish: true })
      this.setState('paused')
    }
    return true
  }

  onProviderError(error) {
    if (this.closed) return
    this.fail('provider_error', error?.message || 'Dictation provider failed.')
  }

  fail(code, message) {
    if (this.closed) return
    this.error(code, message)
    this.transcriber?.close?.({ finish: false })
    this.clearEphemeral()
    this.setState('error')
  }

  clearEphemeral() {
    this.pendingIntent = null
    this.pendingContext = null
    this.pendingOperation = null
    this.pendingCommit = null
    this.clearTimer(this.timer)
    this.timer = null
  }

  cancel() {
    if (this.closed) return
    this.transcriber?.close?.({ finish: false })
    this.clearEphemeral()
    this.setState('cancelled')
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.transcriber?.close?.({ finish: false })
    this.clearEphemeral()
    this.commitRegistry.clear()
  }
}
