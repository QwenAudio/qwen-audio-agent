import { GatewayServerEvent } from '../../../shared/realtime-events.mjs'
import {
  ensureResponseContext,
  mergeResponseContext,
  responseActivityContextPatch,
} from './response-context.mjs'
import {
  evaluateResponseGuards,
  isResponseGuardTurnCurrent,
} from './response-guards/index.mjs'
import {
  containsReservedProtocolEnvelope,
} from './response-guards/reserved-protocol-envelope.mjs'
import { realtimeResponseId } from './response-lifecycle.mjs'

const PRESENTATION_RESPONSE_EVENTS = new Set([
  'response.created',
  'response.audio.delta',
  'response.output_audio.delta',
  'response.audio_transcript.delta',
  'response.output_audio_transcript.delta',
  'response.audio_transcript.done',
  'response.output_audio_transcript.done',
  'response.text.delta',
  'response.text.done',
  'response.done',
])

export function confirmsTaskNotificationOnPlaybackStart(context) {
  return Boolean(
    context
    && (
      context.origin === 'announcement'
      || context.consumesTaskNotification
    ),
  )
}

export function acceptsPlaybackReceipt({
  outputEnabled,
  active,
  responseKnown,
}) {
  return outputEnabled === true && active === true && responseKnown === true
}

function contextTaskIds(context) {
  return context?.taskIds?.length
    ? context.taskIds
    : [context?.taskId].filter(Boolean)
}

function awaitsToolFollowUp(context) {
  return Boolean(context?.awaitsToolFollowUp ?? context?.hasFunctionCall)
}

/**
 * Owns response correlation and user-visible presentation for one realtime
 * connection. Audio/text provider events and client playback receipts meet at
 * this boundary so a response is acknowledged, retried and recorded once.
 */
export class RealtimePresentationRuntime {
  constructor({
    ownerId,
    sessionId,
    turns,
    conversationSync,
    announcementWindow,
    announcements,
    toolCalls,
    send,
    getFrontend,
    getOutputEnabled,
    getNonVoiceClient,
    getResponseTurnCandidate,
    clearResponseCandidate,
    announcementQuietMs,
    responseContextCleanupMs,
    turnCitations = null,
  }) {
    this.ownerId = ownerId
    this.sessionId = sessionId
    this.turns = turns
    this.conversationSync = conversationSync
    this.announcementWindow = announcementWindow
    this.announcements = announcements
    this.toolCalls = toolCalls
    this.send = send
    this.getFrontend = getFrontend
    this.getOutputEnabled = getOutputEnabled
    this.getNonVoiceClient = getNonVoiceClient
    this.getResponseTurnCandidate = getResponseTurnCandidate
    this.clearResponseCandidate = clearResponseCandidate
    this.announcementQuietMs = announcementQuietMs
    this.responseContextCleanupMs = responseContextCleanupMs
    this.turnCitations = turnCitations
    this.contexts = new Map()
    this.playbackTurns = new Map()
  }

  has(id) {
    return this.contexts.has(id)
  }

  get(id) {
    return this.contexts.get(id)
  }

  entries() {
    return this.contexts.entries()
  }

  markFunctionCall(id) {
    const context = this.contexts.get(id)
    if (context) {
      context.hasFunctionCall = true
      this.send({
        type: GatewayServerEvent.VOICE_STATE,
        state: 'processing',
        turnId: context.turnId || this.turns.turnId,
        origin: context.origin || 'model',
      })
    }
    return context
  }

  publicContext(context = {}) {
    return {
      turnId: context.turnId,
      taskId: context.taskId,
      taskIds: context.taskIds,
      origin: context.origin,
      turnGeneration: context.turnGeneration,
    }
  }

  fallbackContext() {
    return {
      turnId: this.turns.committedTurnId || this.turns.turnId,
      taskId: null,
      origin: 'model',
      turnGeneration: this.turns.committedTurnId
        ? this.turns.committedTurnGeneration
        : this.turns.turnGeneration,
    }
  }

  begin(event) {
    const id = realtimeResponseId(event)
    if (!id) return null
    const existing = this.contexts.get(id)
    const automaticResponse = (
      !existing
      && (event.__voiceOrigin || 'model') === 'model'
      && !event.__voiceContext?.turnId
    )
    const automaticTurn = automaticResponse
      ? this.getResponseTurnCandidate()
      : null
    const fallback = {
      turnId: event.__voiceContext?.turnId
        || automaticTurn?.turnId
        || this.turns.committedTurnId
        || this.turns.turnId,
      taskId: event.__voiceContext?.taskId || null,
      origin: event.__voiceOrigin || 'model',
      authorizationId: event.__voiceContext?.authorizationId || null,
      turnGeneration: Number.isInteger(event.__voiceContext?.turnGeneration)
        ? event.__voiceContext.turnGeneration
        : automaticTurn?.turnGeneration
          ?? (this.turns.committedTurnId
            ? this.turns.committedTurnGeneration
            : this.turns.turnGeneration),
    }
    const context = mergeResponseContext(
      this.contexts,
      id,
      responseActivityContextPatch({ existing, event, fallback }),
    )
    if (
      this.turns.manualInputGeneration !== null
      && !automaticResponse
      && context.turnGeneration === this.turns.manualInputGeneration
      && context.origin === 'model'
    ) {
      this.turns.finishManualResponse(context)
    }
    if (
      context.playbackStarted
      && confirmsTaskNotificationOnPlaybackStart(context)
    ) {
      this.announcements.confirmMany(contextTaskIds(context))
    }
    if (automaticTurn) {
      this.turns.commit(automaticTurn)
      this.clearResponseCandidate()
    }
    if (!context.responseStarted) {
      context.responseStarted = true
      this.send({
        type: GatewayServerEvent.RESPONSE_STARTED,
        responseId: id,
        ...this.publicContext(context),
      })
    }
    return context
  }

  handle(event) {
    if (!PRESENTATION_RESPONSE_EVENTS.has(event?.type)) return false
    if (event.type === 'response.created') return true
    if (
      event.type === 'response.audio.delta'
      || event.type === 'response.output_audio.delta'
    ) {
      this.#audioDelta(event)
    } else if (
      event.type === 'response.audio_transcript.delta'
      || event.type === 'response.output_audio_transcript.delta'
    ) {
      this.#audioTranscriptDelta(event)
    } else if (
      event.type === 'response.audio_transcript.done'
      || event.type === 'response.output_audio_transcript.done'
    ) {
      this.#audioTranscriptDone(event)
    } else if (event.type === 'response.text.delta') {
      this.#textDelta(event)
    } else if (event.type === 'response.text.done') {
      this.#textDone(event)
    } else if (event.type === 'response.done') {
      this.#responseDone(event)
    }
    return true
  }

  #contextFor(event) {
    return ensureResponseContext(
      this.contexts,
      realtimeResponseId(event),
      this.fallbackContext(),
    )
  }

  #audioDelta(event) {
    const id = realtimeResponseId(event)
    const context = this.#contextFor(event)
    if (context?.suppressed) return
    const responseTurnId = context.turnId || this.turns.turnId
    if (id) {
      context.hasAudio = true
      this.playbackTurns.set(id, responseTurnId)
      this.announcementWindow.queueAudio(id, {
        turnId: responseTurnId,
        origin: context.origin || 'model',
      })
    }
    this.send({
      type: GatewayServerEvent.AUDIO_DELTA,
      audio: event.delta,
      sampleRate: Number(event.sampleRate)
        || this.getFrontend().provider.outputSampleRate,
      responseId: id,
      turnId: responseTurnId,
    })
  }

  #audioTranscriptDelta(event) {
    const id = realtimeResponseId(event)
    const context = this.#contextFor(event)
    if (context.suppressed) return
    if (!context.playbackStarted) {
      context.pendingTranscripts.push({
        content: event.delta || '',
        final: false,
      })
      return
    }
    this.#emitTranscript({
      id,
      context,
      content: event.delta || '',
      final: false,
    })
  }

  #audioTranscriptDone(event) {
    const id = realtimeResponseId(event)
    const context = this.#contextFor(event)
    if (context.suppressed) return
    context.transcriptDone = true
    context.assistantTranscript = event.transcript || ''
    if (!context.playbackStarted) {
      context.pendingTranscripts.push({
        content: event.transcript || '',
        final: true,
      })
    } else {
      this.#emitTranscript({
        id,
        context,
        content: event.transcript || '',
        final: true,
      })
    }
    this.#finishContextIfComplete(id, context)
  }

  #textDelta(event) {
    const id = realtimeResponseId(event)
    const context = this.#contextFor(event)
    if (context.suppressed) return
    this.#emitTranscript({
      id,
      context,
      content: event.delta || '',
      final: false,
    })
  }

  #textDone(event) {
    const id = realtimeResponseId(event)
    const context = this.#contextFor(event)
    if (context.suppressed) return
    context.transcriptDone = true
    context.assistantTranscript = event.text || ''
    this.#emitTranscript({
      id,
      context,
      content: event.text || '',
      final: true,
    })
  }

  #responseDone(event) {
    const id = realtimeResponseId(event)
    const context = this.contexts.get(id)
    const terminalToolResponse = this.toolCalls.consumeTerminalToolResponse(id)
    const responseTurnId = context?.turnId || this.turns.turnId
    const responseStatus = event.response?.status
    const failed = ['failed', 'cancelled', 'incomplete'].includes(responseStatus)
    const suppressToolFollowUp = Boolean(
      failed
      || context?.suppressed
      || context?.hasAudio
      || context?.assistantTranscript?.trim()
    )
    const toolFollowUpPending = Boolean(
      context?.hasFunctionCall
      && !terminalToolResponse
      && !suppressToolFollowUp,
    )
    if (context) context.awaitsToolFollowUp = toolFollowUpPending
    this.toolCalls.finishToolResponse(id, {
      suppressResponse: suppressToolFollowUp,
    }).catch(error => this.send({
      type: GatewayServerEvent.ERROR,
      message: error.message,
    }))
    const guardDecision = evaluateResponseGuards({
      origin: context?.origin || 'model',
      hasFunctionCall: Boolean(context?.hasFunctionCall),
      failed,
      suppressed: Boolean(context?.suppressed),
      transcript: context?.assistantTranscript || '',
    })
    if (!context?.suppressed) {
      this.send({
        type: GatewayServerEvent.AUDIO_DONE,
        responseId: id,
        turnId: responseTurnId,
      })
      if (!context?.hasAudio && !toolFollowUpPending) {
        this.send({
          type: GatewayServerEvent.VOICE_STATE,
          state: 'idle',
          turnId: responseTurnId,
          origin: context?.origin || 'model',
        })
      }
    }
    if (context?.hasAudio && !failed) {
      context.responseDone = true
      this.#finishContextIfComplete(id, context)
    } else {
      const nonVoiceClient = this.getNonVoiceClient()
      const completedNonVoiceAnnouncement = (
        context?.origin === 'announcement'
        && nonVoiceClient
        && !failed
      )
      const completedNonVoiceTaskNotification = (
        context?.consumesTaskNotification
        && nonVoiceClient
        && !failed
      )
      if (
        context
        && !failed
        && (
          context.origin !== 'announcement'
          || completedNonVoiceAnnouncement
        )
      ) {
        this.#flushPendingTranscripts(id, context)
      }
      if (context?.origin === 'announcement') {
        if (completedNonVoiceAnnouncement) {
          this.announcements.confirmMany(contextTaskIds(context))
        } else {
          this.announcements.retryMany(contextTaskIds(context))
        }
      } else if (completedNonVoiceTaskNotification) {
        this.announcements.confirmMany(contextTaskIds(context))
      }
      this.contexts.delete(id)
    }
    if (failed && id) {
      this.playbackTurns.delete(id)
      this.announcementWindow.finishPlayback(id, {
        awaitsToolFollowUp: false,
      })
    }
    this.announcementWindow.responseDone({
      turnId: responseTurnId,
      origin: context?.origin || 'model',
      hasAudio: Boolean(context?.hasAudio && !context?.playbackEnded),
      awaitsToolFollowUp: toolFollowUpPending,
      suppressed: Boolean(context?.suppressed) || terminalToolResponse,
      failed,
    })
    if (guardDecision) this.#requestGuardCorrection(guardDecision, context, responseTurnId)
    this.#flushAnnouncementsSoon()
  }

  #requestGuardCorrection(decision, context, responseTurnId) {
    const frontend = this.getFrontend()
    if (
      !this.getOutputEnabled()
      || !frontend?.ready
      || !frontend.capabilities.perResponseInstructions
    ) return
    const generation = context?.turnGeneration
    frontend.ensureResponse({
      turnId: responseTurnId,
      turnGeneration: generation,
    }, {
      shouldCreate: () => isResponseGuardTurnCurrent({
        sameFrontend: this.getFrontend() === frontend,
        outputEnabled: this.getOutputEnabled(),
        userSpeaking: this.turns.userSpeaking,
        responseTurnId,
        responseTurnGeneration: generation,
        committedTurnId: this.turns.committedTurnId,
        committedTurnGeneration: this.turns.committedTurnGeneration,
      }),
      response: { instructions: decision.instructions },
    }).catch(error => this.send({
      type: GatewayServerEvent.ERROR,
      message: error.message,
    }))
  }

  #emitTranscript({ id, context, content, final }) {
    const citations = final && String(content || '').trim()
      ? this.turnCitations?.consume(context.turnId) || []
      : []
    const invalidModelProtocol = Boolean(
      final
      && context.origin === 'model'
      && containsReservedProtocolEnvelope(content),
    )
    if (final && !invalidModelProtocol) {
      this.conversationSync.record({
        ownerId: this.ownerId,
        sessionId: this.sessionId,
        id: `voice:assistant:${id}`,
        role: 'assistant',
        content,
        source: context.origin === 'model'
          ? 'realtime-direct'
          : 'agent-presentation',
        ...(citations.length ? { citations } : {}),
        ...context,
      })
    }
    this.send({
      type: final
        ? GatewayServerEvent.TRANSCRIPT_FINAL
        : GatewayServerEvent.TRANSCRIPT_DELTA,
      role: 'assistant',
      content: content || '',
      responseId: id,
      ...(citations.length ? { citations } : {}),
      ...this.publicContext(context),
    })
  }

  #flushPendingTranscripts(id, context) {
    for (const transcript of context?.pendingTranscripts || []) {
      this.#emitTranscript({
        id,
        context,
        content: transcript.content,
        final: transcript.final,
      })
    }
    if (context) context.pendingTranscripts = []
  }

  #finishContextIfComplete(id, context) {
    if (
      context
      && context.playbackEnded
      && context.responseDone
      && context.transcriptDone
    ) {
      this.contexts.delete(id)
    }
  }

  #scheduleContextCleanup(id, context) {
    const timer = setTimeout(() => {
      if (this.contexts.get(id) !== context) return
      this.contexts.delete(id)
      this.playbackTurns.delete(id)
      this.announcementWindow.finishPlayback(id, {
        awaitsToolFollowUp: awaitsToolFollowUp(context),
      })
    }, this.responseContextCleanupMs)
    timer.unref?.()
  }

  #flushAnnouncementsSoon() {
    const timer = setTimeout(
      () => this.announcements.flush(),
      this.announcementQuietMs,
    )
    timer.unref?.()
  }

  startPlayback(id) {
    const context = this.contexts.get(id)
    if (context?.suppressed) return
    this.announcementWindow.startPlayback(id)
    const playbackTurnId = context?.turnId
      || this.playbackTurns.get(id)
      || this.turns.turnId
    this.send({
      type: GatewayServerEvent.VOICE_STATE,
      state: 'speaking',
      turnId: playbackTurnId,
      origin: context?.origin || 'model',
    })
    if (!context || context.playbackStarted) return
    context.playbackStarted = true
    if (confirmsTaskNotificationOnPlaybackStart(context)) {
      this.announcements.confirmMany(contextTaskIds(context))
    }
    this.#flushPendingTranscripts(id, context)
  }

  finishPlayback(id) {
    const playbackTurnId = this.playbackTurns.get(id) || this.turns.turnId
    const context = this.contexts.get(id)
    if (context?.suppressed) {
      this.playbackTurns.delete(id)
      return
    }
    this.announcementWindow.finishPlayback(id, {
      awaitsToolFollowUp: awaitsToolFollowUp(context),
    })
    this.playbackTurns.delete(id)
    if (context) {
      context.playbackEnded = true
      this.#finishContextIfComplete(id, context)
      if (this.contexts.get(id) === context) {
        this.#scheduleContextCleanup(id, context)
      }
    }
    const remainsProcessing = Boolean(
      awaitsToolFollowUp(context),
    )
    this.send({
      type: GatewayServerEvent.VOICE_STATE,
      state: this.turns.userSpeaking
        ? 'listening'
        : remainsProcessing
          ? 'processing'
          : 'idle',
      turnId: this.turns.userSpeaking ? this.turns.turnId : playbackTurnId,
      origin: context?.origin || 'model',
    })
    this.#flushAnnouncementsSoon()
  }

  cancelPlayback(id, { reason = '' } = {}) {
    const context = this.contexts.get(id)
    this.announcementWindow.finishPlayback(id, {
      awaitsToolFollowUp: awaitsToolFollowUp(context),
    })
    const playbackTurnId = this.playbackTurns.get(id) || this.turns.turnId
    this.playbackTurns.delete(id)
    if (context?.origin === 'announcement') {
      if (reason === 'user_interruption') {
        this.announcements.confirmMany(contextTaskIds(context))
      } else {
        this.announcements.retryMany(contextTaskIds(context))
      }
    }
    if (context?.playbackStarted && reason === 'user_interruption') {
      this.send({
        type: GatewayServerEvent.RESPONSE_INTERRUPTED,
        responseId: id,
        ...this.publicContext(context),
      })
    }
    if (context) {
      context.suppressed = true
      context.playbackEnded = true
      context.pendingTranscripts = []
      this.#scheduleContextCleanup(id, context)
    }
    this.send({
      type: GatewayServerEvent.VOICE_STATE,
      state: this.turns.userSpeaking ? 'listening' : 'idle',
      turnId: this.turns.userSpeaking ? this.turns.turnId : playbackTurnId,
      origin: context?.origin || 'model',
    })
    this.#flushAnnouncementsSoon()
  }

  cancelPermission(authorizationId) {
    for (const [responseId, context] of this.contexts) {
      if (
        context.origin === 'permission'
        && context.authorizationId === authorizationId
        && !context.suppressed
      ) {
        this.cancelPlayback(responseId, { reason: 'permission_resolved' })
      }
    }
  }

  failResponse(event) {
    const id = realtimeResponseId(event)
    const context = this.contexts.get(id)
    if (context?.origin === 'announcement') {
      this.send({ type: GatewayServerEvent.PLAYBACK_CLEAR })
      this.announcementWindow.finishPlayback(id)
      this.playbackTurns.delete(id)
      this.contexts.delete(id)
      this.announcements.retryMany(contextTaskIds(context))
    } else {
      if (id && context?.hasAudio) {
        this.send({
          type: GatewayServerEvent.AUDIO_DONE,
          responseId: id,
          turnId: context.turnId || this.turns.turnId,
        })
        this.#scheduleContextCleanup(id, context)
      } else if (id) {
        this.contexts.delete(id)
        this.playbackTurns.delete(id)
      }
      this.announcementWindow.responseDone({
        turnId: context?.turnId || this.turns.turnId,
        origin: context?.origin || 'model',
        hasAudio: Boolean(context?.hasAudio),
        awaitsToolFollowUp: false,
        failed: true,
      })
    }
    this.#flushAnnouncementsSoon()
  }

  clear() {
    this.contexts.clear()
    this.playbackTurns.clear()
  }
}
