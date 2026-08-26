import { normalizeConversationSessionId } from '../../shared/conversation-session.mjs'

export function requestedSessionId(search) {
  return normalizeConversationSessionId(
    new URLSearchParams(search).get('session') || '',
  )
}
