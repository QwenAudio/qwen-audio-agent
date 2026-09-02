// Twenty user/assistant turns in the common case. This window is shared by live
// frontend history and Realtime Session restoration so reconnects retain enough
// conversational continuity without growing the injected context unboundedly.
export const RECENT_CONVERSATION_MESSAGE_LIMIT = 40

export function recentConversationMessages(
  messages = [],
  limit = RECENT_CONVERSATION_MESSAGE_LIMIT,
) {
  const boundedLimit = Number.isInteger(limit) && limit >= 0
    ? limit
    : RECENT_CONVERSATION_MESSAGE_LIMIT
  if (boundedLimit === 0) return []
  return messages.slice(-boundedLimit)
}
