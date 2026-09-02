export function finalUserTranscript(event) {
  if (event?.role !== 'user' || event.final !== true) return ''
  return String(event.content || '').replace(/\s+/gu, ' ').trim()
}

function eventId(value) {
  return String(value || '').trim()
}

export function voiceConversationMessageId(event, fallback = '') {
  if (event?.role === 'assistant') {
    const responseId = eventId(event.responseId)
    if (responseId) return `voice:assistant:${responseId}`
  }
  if (event?.role === 'user') {
    const turnId = eventId(event.turnId)
    if (turnId) return `voice:user:${turnId}`
  }
  return fallback
}

export function voiceEventBelongsToTurn(event, currentTurnId) {
  const eventTurnId = eventId(event?.turnId)
  const activeTurnId = eventId(currentTurnId)
  return !eventTurnId || !activeTurnId || eventTurnId === activeTurnId
}
