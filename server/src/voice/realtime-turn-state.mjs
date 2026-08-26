import { TurnCorrelation } from './turn-correlation.mjs'

function defaultVoiceTurnId(generation) {
  return `voice-${Date.now()}-${generation}`
}

/**
 * Owns the mutable turn state for one realtime client connection.
 *
 * Provider events, manual input and client interruption all advance the same
 * generation boundary. Keeping that boundary here prevents late provider
 * events from reclaiming a newer turn through ad-hoc state updates in the
 * Gateway.
 */
export class RealtimeTurnState {
  constructor({
    correlation = new TurnCorrelation(),
    createVoiceTurnId = defaultVoiceTurnId,
  } = {}) {
    this.correlation = correlation
    this.createVoiceTurnId = createVoiceTurnId
    this.turnId = ''
    this.turnGeneration = 0
    this.turnSequence = 0
    this.committedTurnId = ''
    this.committedTurnGeneration = 0
    this.userSpeaking = false
    this.voiceStartItemId = ''
    this.manualInputGeneration = null
  }

  current() {
    return {
      turnId: this.turnId,
      turnGeneration: this.turnGeneration,
    }
  }

  committed() {
    return {
      turnId: this.committedTurnId,
      turnGeneration: this.committedTurnGeneration,
    }
  }

  beginVoice(itemId) {
    if (this.manualInputGeneration !== null) {
      this.correlation.invalidate(itemId)
      return { accepted: false, context: null }
    }

    this.userSpeaking = true
    const known = itemId && !this.correlation.isComplete(itemId)
      ? this.correlation.resolve(itemId, null)
      : null
    if (known) {
      this.turnId = known.turnId
      this.turnGeneration = known.turnGeneration
    } else {
      this.turnGeneration = ++this.turnSequence
      this.turnId = this.createVoiceTurnId(this.turnGeneration)
      this.correlation.remember(itemId, this.current(), { replace: true })
    }
    this.voiceStartItemId = itemId || ''
    return { accepted: true, context: this.current() }
  }

  endSpeech() {
    this.userSpeaking = false
  }

  beginManual(turnId) {
    const supersededVoiceTurn = this.userSpeaking ? this.current() : null
    this.userSpeaking = false
    this.voiceStartItemId = ''
    this.turnGeneration = ++this.turnSequence
    this.turnId = turnId
    this.manualInputGeneration = this.turnGeneration
    this.correlation.invalidateBeforeGeneration(this.turnGeneration)
    const context = this.current()
    this.commit(context)
    return { context, supersededVoiceTurn }
  }

  resolveInput(itemId) {
    return this.correlation.resolve(itemId, this.current())
  }

  completeInput(itemId) {
    const completed = this.correlation.complete(itemId, this.current())
    if (
      this.voiceStartItemId
      && this.voiceStartItemId !== itemId
      && completed.context?.turnGeneration === this.turnGeneration
    ) {
      this.correlation.complete(this.voiceStartItemId, completed.context)
    }
    if (completed.context?.turnGeneration === this.turnGeneration) {
      this.voiceStartItemId = ''
    }
    return completed
  }

  invalidateInput(itemId) {
    this.correlation.invalidate(itemId)
  }

  isInputInvalid(itemId) {
    return this.correlation.isInvalid(itemId)
  }

  isStale(context) {
    return Number.isInteger(context?.turnGeneration)
      && context.turnGeneration < this.committedTurnGeneration
  }

  commit(context) {
    if (!context?.turnId) return false
    if (
      this.committedTurnId === context.turnId
      && this.committedTurnGeneration === context.turnGeneration
    ) return false
    if (this.isStale(context)) return false
    this.committedTurnId = context.turnId
    this.committedTurnGeneration = context.turnGeneration
    return true
  }

  finishManualResponse(context, { automatic = false } = {}) {
    if (
      this.manualInputGeneration === null
      || automatic
      || context?.turnGeneration !== this.manualInputGeneration
    ) return false
    this.manualInputGeneration = null
    return true
  }

  failManualInput(context) {
    if (context?.turnGeneration !== this.manualInputGeneration) return false
    this.manualInputGeneration = null
    return true
  }

  advanceBoundary() {
    this.turnGeneration = ++this.turnSequence
    this.committedTurnGeneration = this.turnGeneration
    return this.current()
  }

  close() {
    this.advanceBoundary()
    this.voiceStartItemId = ''
    this.correlation.clear()
  }
}
