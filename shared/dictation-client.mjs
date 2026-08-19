import {
  DictationClientEvent,
  DictationServerEvent,
  isDictationServerEvent,
} from './dictation-protocol.mjs'
import { draftPayloadHash } from './dictation-draft.mjs'

function defaultId(prefix) {
  return `${prefix}_${globalThis.crypto.randomUUID().replaceAll('-', '')}`
}

const CAPTURING_STATES = new Set([
  'starting',
  'listening',
  'transcribing',
  'editing',
  'ready-to-send',
])
const RESTARTABLE_STATES = new Set(['stopped', 'cancelled', 'error'])

export function createDictationClient({
  enabled = false,
  send,
  composer,
  createId = defaultId,
  locale = '',
} = {}) {
  let sessionId = ''
  let state = 'idle'
  let clientSeq = 0
  let serverSeq = 0
  let preview = ''
  let resumeRequested = false
  const submittedCommits = new Map()
  const listeners = new Set()

  const snapshot = () => ({
    enabled,
    sessionId,
    state,
    preview,
    capturing: CAPTURING_STATES.has(state),
  })
  const publish = () => {
    const value = snapshot()
    for (const listener of listeners) listener(value)
  }
  const sendEvent = event => {
    if (!sessionId) return false
    return send?.({
      ...event,
      sessionId,
      seq: ++clientSeq,
    }) !== false
  }
  const setState = next => {
    state = next
    publish()
  }
  const rememberCommit = (commitId, submitted) => {
    submittedCommits.set(commitId, submitted)
    if (submittedCommits.size > 512) {
      submittedCommits.delete(submittedCommits.keys().next().value)
    }
  }
  const accepts = event => {
    if (!isDictationServerEvent(event) || event.sessionId !== sessionId) return false
    if (!Number.isSafeInteger(event.seq) || event.seq <= serverSeq) return false
    serverSeq = event.seq
    return true
  }

  return {
    start(options = {}) {
      if (!enabled || (sessionId && !RESTARTABLE_STATES.has(state))) return false
      sessionId = createId('dictation')
      clientSeq = 0
      serverSeq = 0
      preview = ''
      resumeRequested = false
      setState('starting')
      return sendEvent({
        type: DictationClientEvent.START,
        locale,
        continuous: options.continuous !== false,
      })
    },

    pause() {
      if (!CAPTURING_STATES.has(state)) return false
      resumeRequested = false
      return sendEvent({ type: DictationClientEvent.PAUSE })
    },

    resume() {
      if (state !== 'paused') return false
      const sent = sendEvent({ type: DictationClientEvent.RESUME })
      resumeRequested = sent
      return sent
    },

    cancel() {
      if (!sessionId) return false
      const sent = sendEvent({ type: DictationClientEvent.CANCEL })
      resumeRequested = false
      setState('cancelled')
      return sent
    },

    stop() {
      if (!CAPTURING_STATES.has(state)) return false
      const sent = sendEvent({ type: DictationClientEvent.STOP })
      resumeRequested = false
      setState('stopped')
      return sent
    },

    appendAudio(audio) {
      if (!CAPTURING_STATES.has(state)) return false
      return sendEvent({
        type: DictationClientEvent.AUDIO_APPEND,
        audio: String(audio || ''),
      })
    },

    handle(event) {
      if (!accepts(event)) return false
      if (event.type === DictationServerEvent.STATE) {
        const next = String(event.state || 'error')
        if (CAPTURING_STATES.has(next)) {
          if (RESTARTABLE_STATES.has(state)) return false
          if (
            state === 'paused'
            && (!resumeRequested || next !== 'listening')
          ) return false
        }
        if (state === 'paused' && CAPTURING_STATES.has(next)) {
          resumeRequested = false
        }
        if (['paused', 'stopped', 'cancelled', 'error'].includes(next)) {
          resumeRequested = false
        }
        if (['stopped', 'cancelled'].includes(next)) preview = ''
        setState(next)
        return true
      }
      if (event.type === DictationServerEvent.TRANSCRIPT_DELTA) {
        preview = String(event.text || '')
        publish()
        return true
      }
      if (event.type === DictationServerEvent.TRANSCRIPT_FINAL) {
        preview = String(event.text || '')
        publish()
        return true
      }
      if (event.type === DictationServerEvent.ERROR) {
        if (state === 'paused' || RESTARTABLE_STATES.has(state)) return false
        preview = ''
        resumeRequested = false
        setState('error')
        return true
      }
      if (event.type === DictationServerEvent.CONTEXT_REQUEST) {
        if (state !== 'editing') return false
        const current = composer.snapshot()
        return sendEvent({
          type: DictationClientEvent.CONTEXT,
          requestId: event.requestId,
          text: current.text,
          selectionStart: current.selectionStart,
          selectionEnd: current.selectionEnd,
          revision: current.revision,
        })
      }
      if (event.type === DictationServerEvent.OPERATION) {
        if (state !== 'editing') return false
        const current = composer.snapshot()
        let result = {
          applied: false,
          reason: 'revision_conflict',
          revision: current.revision,
        }
        if (current.revision === Number(event.baseRevision)) {
          result = composer.applyOperation(event)
        }
        preview = ''
        return sendEvent({
          type: DictationClientEvent.OPERATION_ACK,
          operationId: event.operationId,
          status: result.applied ? 'applied' : 'conflict',
          revision: Number(result.revision),
        })
      }
      if (event.type === DictationServerEvent.COMMIT_REQUEST) {
        if (state !== 'ready-to-send') return false
        const current = composer.snapshot()
        const valid = current.revision === Number(event.revision)
          && draftPayloadHash(current.text) === event.payloadHash
        let submitted = false
        if (valid && submittedCommits.has(event.commitId)) {
          submitted = submittedCommits.get(event.commitId)
        } else if (valid) {
          // Remember before invoking the composer: if submission throws after a
          // partial side effect, a replay still cannot call it twice.
          rememberCommit(event.commitId, false)
          try {
            submitted = composer.commitDictation(event.commitId) !== false
          } catch {
            submitted = false
          }
          rememberCommit(event.commitId, submitted)
        }
        return sendEvent({
          type: DictationClientEvent.COMMIT_ACK,
          commitId: event.commitId,
          status: submitted ? 'submitted' : 'rejected',
        })
      }
      return false
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    snapshot,
  }
}
