export const RECENT_CONVERSATION_MESSAGE_LIMIT = 10

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
