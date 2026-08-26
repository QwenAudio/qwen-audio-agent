import {
  RECENT_CONVERSATION_MESSAGE_LIMIT,
  recentConversationMessages,
} from '../../../shared/conversation-history.mjs'

const FRONTEND_MESSAGE_SOURCES = new Set([
  'voice-user',
  'text-user',
  'realtime-direct',
  'agent-presentation',
])

/**
 * The single projection shared by Realtime context restoration and visible
 * frontend history. Internal task results stay hidden when a user-facing
 * presentation for the same task already exists.
 */
export function projectFrontendConversation(
  messages = [],
  { limit = RECENT_CONVERSATION_MESSAGE_LIMIT } = {},
) {
  const presentedTaskIds = new Set()
  messages
    .filter(message => message.source === 'agent-presentation')
    .forEach(message => {
      if (message.taskId) presentedTaskIds.add(message.taskId)
      message.taskIds?.forEach(taskId => presentedTaskIds.add(taskId))
    })
  return recentConversationMessages(messages.filter(message => (
    FRONTEND_MESSAGE_SOURCES.has(message.source)
    || (
      message.source === 'agent-result'
      && message.taskId
      && !presentedTaskIds.has(message.taskId)
    )
  )), limit)
}
