/** Pure BackendPort conversation DTO helpers; no history store dependencies. */
export const COORDINATOR_CONVERSATION_MAX_CHARS = 2_000

const SOURCES_BY_ROLE = {
  user: new Set(['voice-user', 'text-user']),
  assistant: new Set(['realtime-direct', 'agent-presentation']),
}

function position(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0
}

function budget(value) {
  return Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, COORDINATOR_CONVERSATION_MAX_CHARS)
    : COORDINATOR_CONVERSATION_MAX_CHARS
}

function line(message) {
  return `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content}`
}

function truncate(value, limit) {
  if (value.length <= limit) return value
  if (limit < 1) return ''
  let prefix = value.slice(0, limit - 1)
  // A budget is measured in UTF-16 code units, but never split a surrogate pair.
  if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1)
  return `${prefix}…`
}

function recentMessages(messages, maxChars) {
  const selected = []
  let used = 0
  let truncated = false
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    const size = line(message).length + (selected.length ? 1 : 0)
    if (used + size > maxChars) {
      truncated = true
      // Preserve a contiguous suffix of whole messages. Only a single newest
      // overlong message is shortened; never replace newer context with older.
      if (!selected.length) {
        const contentBudget = maxChars - line({ ...message, content: '' }).length
        if (contentBudget > 0) {
          selected.push({ ...message, content: truncate(message.content, contentBudget) })
        }
      }
      break
    }
    selected.push({ ...message })
    used += size
  }
  return { messages: selected.reverse(), truncated }
}

/**
 * Capture at Task admission, not when the backend eventually runs. Reuses the
 * existing history and copies at most one bounded text window, never a second
 * conversation store. The snapshot is JSON-serializable with the accepted work.
 *
 * ConversationSync records these sources only on final user input / natural
 * assistant presentation. Raw agent-result, tool events and partial text are
 * deliberately not eligible, including raw results not yet presented aloud.
 */
export function captureCoordinatorConversation(messages = [], {
  sessionId,
  excludeTurnId,
  maxChars = COORDINATOR_CONVERSATION_MAX_CHARS,
} = {}) {
  const scope = String(sessionId || '')
  if (!scope) throw new TypeError('conversation sessionId is required')
  const limit = budget(maxChars)
  const ordered = messages.filter(message => (
    position(message.historyPosition)
    && SOURCES_BY_ROLE[message.role]?.has(message.source)
    && message.final !== false
    && message.id
    && String(message.content || '').trim()
  )).sort((left, right) => left.historyPosition - right.historyPosition)
  const last = ordered.at(-1)
  const eligible = ordered.filter(message => (
    !(message.role === 'user' && excludeTurnId && message.turnId === excludeTurnId)
  )).map(message => ({
    id: String(message.id),
    role: message.role,
    content: String(message.content),
    position: message.historyPosition,
  }))
  const selected = recentMessages(eligible, limit)
  return {
    version: 1,
    sessionId: scope,
    maxChars: limit,
    firstPosition: ordered[0]?.historyPosition || 0,
    messages: selected.messages,
    truncated: selected.truncated,
    // The current input is already conveyed by the task objective. Include its
    // position in the watermark even though its text is excluded above.
    cursor: {
      sessionId: scope,
      messageId: last ? String(last.id) : null,
      position: last?.historyPosition || 0,
    },
  }
}

/**
 * Resolve at actual delivery against the last ACKNOWLEDGED durable cursor.
 * Never persist the returned cursor until its prompt was accepted; retries can
 * reuse the immutable admission snapshot without reading any later dialogue.
 */
export function conversationDelta(snapshot, acknowledgedCursor = null) {
  if (snapshot?.version !== 1 || !snapshot.sessionId || !Array.isArray(snapshot.messages)) {
    throw new TypeError('a coordinator conversation snapshot is required')
  }
  const sameSession = acknowledgedCursor?.sessionId === snapshot.sessionId
  const after = sameSession ? position(acknowledgedCursor.position) : 0
  const through = position(snapshot.cursor?.position)
  if (sameSession && after >= through) {
    return {
      text: '', messages: [], cursor: { ...acknowledgedCursor },
      truncated: false, gap: false, stale: true,
    }
  }
  const selected = recentMessages(
    snapshot.messages.filter(message => message.position > after && message.position <= through),
    budget(snapshot.maxChars),
  )
  return {
    text: selected.messages.map(line).join('\n'),
    messages: selected.messages,
    cursor: { ...snapshot.cursor },
    truncated: snapshot.truncated || selected.truncated,
    gap: Boolean(after && snapshot.firstPosition > after),
    stale: false,
  }
}
