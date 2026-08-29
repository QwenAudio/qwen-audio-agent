export class AnnouncementWindow {
  constructor() {
    this.userSpeaking = false
    this.activeTurnId = ''
    this.turnPending = false
    this.audioResponses = new Map()
    this.playingResponses = new Set()
  }

  beginTurn(turnId) {
    this.userSpeaking = true
    this.activeTurnId = String(turnId || '')
    this.turnPending = true
  }

  endSpeech() {
    this.userSpeaking = false
  }

  responseDone({
    turnId,
    origin = 'model',
    hasAudio = false,
    awaitsToolFollowUp = false,
    suppressed = false,
    failed = false,
  } = {}) {
    if (
      origin === 'announcement'
      || String(turnId || '') !== this.activeTurnId
      || hasAudio
      || (awaitsToolFollowUp && !suppressed && !failed)
    ) return
    this.turnPending = false
  }

  queueAudio(responseId, context = {}) {
    const id = String(responseId || '')
    if (!id) return
    this.audioResponses.set(id, {
      turnId: String(context.turnId || ''),
      origin: context.origin || 'model',
    })
  }

  startPlayback(responseId) {
    const id = String(responseId || '')
    if (id) this.playingResponses.add(id)
  }

  finishPlayback(responseId, { awaitsToolFollowUp = false } = {}) {
    const id = String(responseId || '')
    const context = this.audioResponses.get(id)
    this.audioResponses.delete(id)
    this.playingResponses.delete(id)
    if (
      context?.origin !== 'announcement'
      && context?.turnId
      && context.turnId === this.activeTurnId
      && !awaitsToolFollowUp
    ) {
      this.turnPending = false
    }
  }

  interrupt() {
    this.turnPending = false
  }

  reset() {
    this.userSpeaking = false
    this.activeTurnId = ''
    this.turnPending = false
    this.audioResponses.clear()
    this.playingResponses.clear()
  }

  isBlocked() {
    return (
      this.userSpeaking
      || this.turnPending
      || this.audioResponses.size > 0
    )
  }

  isPlaying() {
    return this.playingResponses.size > 0
  }
}
