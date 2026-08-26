import { randomUUID } from 'node:crypto'
import { GatewayServerEvent } from '../../../shared/realtime-events.mjs'
import {
  displayInputText,
  inputFileParts,
  inputText,
  normalizeInputParts,
  withAttachmentAnchors,
} from '../../../shared/input-parts.mjs'
import { streamingInputTranscript } from './input-transcript.mjs'

const PROVIDER_INPUT_EVENTS = new Set([
  'input_audio_buffer.speech_started',
  'input_audio_buffer.speech_stopped',
  'input_audio_buffer.committed',
  'conversation.item.ambient_audio_transcription.completed',
  'conversation.item.input_audio_transcription.delta',
  'conversation.item.input_audio_transcription.text',
  'conversation.item.input_audio_transcription.completed',
  'conversation.item.input_audio_transcription.failed',
])

/**
 * Owns user-input lifecycle semantics for one realtime connection.
 *
 * It translates provider VAD/transcription events and discrete text/file
 * submissions into the same Gateway turn model. Response, playback, task and
 * provider-connection lifecycles remain outside this boundary.
 */
export class RealtimeInputRuntime {
  constructor({
    ownerId,
    sessionId,
    turns,
    transcripts,
    inputAssets,
    conversationSync,
    announcementWindow,
    announcements,
    send,
    getFrontend,
    ensureFrontend,
    clearResponseCandidate,
    expectResponseFor,
    shouldEnsurePermissionResponse,
    ensurePermissionResponseFor,
    reportFrontendError,
    createInputTurnId = () => `text_${randomUUID().replaceAll('-', '')}`,
  }) {
    this.ownerId = ownerId
    this.sessionId = sessionId
    this.turns = turns
    this.transcripts = transcripts
    this.inputAssets = inputAssets
    this.conversationSync = conversationSync
    this.announcementWindow = announcementWindow
    this.announcements = announcements
    this.send = send
    this.getFrontend = getFrontend
    this.ensureFrontend = ensureFrontend
    this.clearResponseCandidate = clearResponseCandidate
    this.expectResponseFor = expectResponseFor
    this.shouldEnsurePermissionResponse = shouldEnsurePermissionResponse
    this.ensurePermissionResponseFor = ensurePermissionResponseFor
    this.reportFrontendError = reportFrontendError
    this.createInputTurnId = createInputTurnId
  }

  handles(event) {
    return PROVIDER_INPUT_EVENTS.has(event?.type)
  }

  handleProviderEvent(event) {
    if (!this.handles(event)) return false

    if (event.type === 'input_audio_buffer.speech_started') {
      this.#startSpeech(event)
    } else if (event.type === 'input_audio_buffer.speech_stopped') {
      this.#stopSpeech(event)
    } else if (event.type === 'input_audio_buffer.committed') {
      this.#commitAudio(event)
    } else if (event.type === 'conversation.item.ambient_audio_transcription.completed') {
      this.turns.completeInput(event.item_id)
    } else if (
      event.type === 'conversation.item.input_audio_transcription.delta'
      || event.type === 'conversation.item.input_audio_transcription.text'
    ) {
      this.#streamTranscript(event)
    } else if (event.type === 'conversation.item.input_audio_transcription.completed') {
      this.#completeTranscript(event)
    } else if (event.type === 'conversation.item.input_audio_transcription.failed') {
      const failedInput = this.turns.completeInput(event.item_id)
      if (failedInput.duplicate) return true
      this.send({
        type: GatewayServerEvent.TRANSCRIPT_DISCARD,
        role: 'user',
        turnId: failedInput.context?.turnId,
      })
    }
    return true
  }

  #startSpeech(event) {
    const started = this.turns.beginVoice(event.item_id)
    if (!started.accepted) return
    this.clearResponseCandidate()
    this.announcementWindow.beginTurn(started.context.turnId)
    this.announcements.dismissActive()
    this.send({
      type: GatewayServerEvent.PLAYBACK_CLEAR,
      reason: 'user_interruption',
    })
    this.send({
      type: GatewayServerEvent.TURN_STARTED,
      turnId: started.context.turnId,
    })
    this.send({
      type: GatewayServerEvent.VOICE_STATE,
      state: 'listening',
      turnId: started.context.turnId,
    })
    this.getFrontend()?.cancel()
  }

  #stopSpeech(event) {
    const stoppedTurn = this.turns.resolveInput(event.item_id)
    if (
      this.turns.isInputInvalid(event.item_id)
      || this.turns.isStale(stoppedTurn)
    ) {
      this.turns.invalidateInput(event.item_id)
      return
    }
    this.turns.endSpeech()
    this.announcementWindow.endSpeech()
    if (event.reason === 'turn_invalid') {
      this.turns.invalidateInput(event.item_id)
      this.send({
        type: GatewayServerEvent.TRANSCRIPT_DISCARD,
        role: 'user',
        turnId: stoppedTurn.turnId,
        reason: 'turn_invalid',
      })
      this.send({
        type: GatewayServerEvent.VOICE_STATE,
        state: 'idle',
        turnId: stoppedTurn.turnId,
        origin: 'model',
      })
      return
    }
    this.expectResponseFor(stoppedTurn)
    this.send({
      type: GatewayServerEvent.VOICE_STATE,
      state: 'processing',
      turnId: stoppedTurn.turnId,
      origin: 'model',
    })
  }

  #commitAudio(event) {
    const committedInputTurn = this.turns.resolveInput(event.item_id)
    if (
      this.turns.isInputInvalid(event.item_id)
      || this.turns.isStale(committedInputTurn)
    ) {
      this.turns.invalidateInput(event.item_id)
      return
    }
    this.turns.endSpeech()
    this.announcementWindow.endSpeech()
    this.send({
      type: GatewayServerEvent.VOICE_STATE,
      state: 'processing',
      turnId: committedInputTurn.turnId,
      origin: 'model',
    })
  }

  #streamTranscript(event) {
    if (this.turns.isInputInvalid(event.item_id)) return
    const transcriptTurn = this.turns.resolveInput(event.item_id)
    if (this.turns.isStale(transcriptTurn)) return
    const transcript = streamingInputTranscript(event)
    if (!transcriptTurn?.turnId || !transcript) return
    this.send({
      type: GatewayServerEvent.TRANSCRIPT_DELTA,
      role: 'user',
      content: transcript,
      turnId: transcriptTurn.turnId,
      replace: true,
    })
  }

  #completeTranscript(event) {
    const completedInput = this.turns.completeInput(event.item_id)
    const transcriptTurn = completedInput.context
    if (
      completedInput.invalid
      || completedInput.duplicate
      || this.turns.isStale(transcriptTurn)
    ) return
    const transcript = String(event.transcript || '').trim()
    if (!transcript) {
      this.send({
        type: GatewayServerEvent.TRANSCRIPT_DISCARD,
        role: 'user',
        turnId: transcriptTurn.turnId,
      })
      return
    }
    this.turns.commit(transcriptTurn)
    this.transcripts.record(transcriptTurn.turnId, transcript)
    if (this.shouldEnsurePermissionResponse(transcriptTurn)) {
      this.ensurePermissionResponseFor(transcriptTurn)
    }
    this.conversationSync.record({
      ownerId: this.ownerId,
      sessionId: this.sessionId,
      id: `voice:user:${transcriptTurn.turnId}`,
      role: 'user',
      content: transcript,
      source: 'voice-user',
      turnId: transcriptTurn.turnId,
      inputs: this.inputAssets.metadataForParts(
        this.transcripts.parts(transcriptTurn.turnId),
      ),
    })
    this.send({
      type: GatewayServerEvent.TRANSCRIPT_FINAL,
      role: 'user',
      content: transcript,
      turnId: transcriptTurn.turnId,
    })
  }

  submit(event) {
    let parts
    try {
      parts = withAttachmentAnchors(normalizeInputParts(
        event.parts,
        { fallbackText: event.text },
      ))
    } catch (error) {
      this.send({ type: GatewayServerEvent.ERROR, message: error.message })
      return
    }
    const inputTurnId = this.createInputTurnId()
    parts = this.inputAssets.registerParts({
      ownerId: this.ownerId,
      sessionId: this.sessionId,
      turnId: inputTurnId,
      parts,
    })
    const text = inputText(parts)
    const display = displayInputText(parts)
    const {
      context: inputContext,
      supersededVoiceTurn,
    } = this.turns.beginManual(inputTurnId)
    this.clearResponseCandidate()
    this.announcementWindow.beginTurn(inputTurnId)
    this.announcementWindow.endSpeech()
    this.announcements.dismissActive()
    this.send({
      type: GatewayServerEvent.PLAYBACK_CLEAR,
      reason: 'user_interruption',
    })
    if (supersededVoiceTurn?.turnId) {
      this.send({
        type: GatewayServerEvent.TRANSCRIPT_DISCARD,
        role: 'user',
        turnId: supersededVoiceTurn.turnId,
        reason: 'superseded_by_manual_input',
      })
    }
    this.send({ type: GatewayServerEvent.TURN_STARTED, turnId: inputTurnId })
    this.send({
      type: GatewayServerEvent.VOICE_STATE,
      state: 'processing',
      turnId: inputTurnId,
      origin: 'model',
    })
    this.getFrontend()?.cancel()
    this.transcripts.record(inputTurnId, text || display)
    this.transcripts.recordParts(inputTurnId, inputFileParts(parts))
    this.conversationSync.record({
      ownerId: this.ownerId,
      sessionId: this.sessionId,
      id: `voice:user:${inputTurnId}`,
      role: 'user',
      content: display,
      source: 'text-user',
      turnId: inputTurnId,
      inputs: this.inputAssets.metadataForParts(parts),
    })
    this.send({
      type: GatewayServerEvent.TRANSCRIPT_FINAL,
      role: 'user',
      content: display,
      turnId: inputTurnId,
    })
    this.ensureFrontend()
      .then(() => this.getFrontend().sendUserInput(parts, inputContext))
      .then(outcome => {
        if (!outcome?.timedOut) return
        this.turns.failManualInput(inputContext)
        this.send({
          type: GatewayServerEvent.VOICE_STATE,
          state: 'idle',
          turnId: inputTurnId,
          origin: 'model',
        })
        this.reportFrontendError(new Error(
          '实时模型没有开始回复，请再试一次。',
        ))
      })
      .catch(error => {
        this.turns.failManualInput(inputContext)
        this.reportFrontendError(error)
      })
  }
}
