export const MAX_CONVERSATION_SESSION_ID_LENGTH = 200

export function normalizeConversationSessionId(value) {
  const sessionId = String(value || '').trim()
  if (
    !sessionId
    || sessionId.length > MAX_CONVERSATION_SESSION_ID_LENGTH
    || /[\u0000-\u001f\u007f]/.test(sessionId)
  ) return ''
  return sessionId
}
