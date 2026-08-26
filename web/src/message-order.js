import {
  RECENT_CONVERSATION_MESSAGE_LIMIT,
  recentConversationMessages,
} from '../../shared/conversation-history.mjs'

export function normalizeTranscript(content) {
  return String(content || '').replace(/\s+/g, ' ').trim()
}

export function finalAssistantContent(content, streamedContent = '') {
  const final = String(content || '').replace(/\r\n?/g, '\n').trim()
  return final || String(streamedContent || '')
}

function turnTimestamp(turnId) {
  const match = String(turnId || '').match(/^voice-(\d+)-/)
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY
}

export function insertByTurn(items, message) {
  if (!message.turnId) {
    return recentConversationMessages([...items, message])
  }
  const matching = items
    .map((item, index) => item.turnId === message.turnId ? index : -1)
    .filter(index => index >= 0)
  let insertAt
  if (matching.length) {
    insertAt = message.role === 'user' ? matching[0] : matching.at(-1) + 1
  } else {
    // 只有语音 turn 自带可比较的时间戳；文字 turn（text_*）无法定时，
    // 按到达顺序追加，且不参与时间比较——否则文字轮会被误判为
    // “最晚”，导致后续语音消息全部插到列表顶部。
    const timestamp = turnTimestamp(message.turnId)
    insertAt = Number.isFinite(timestamp)
      ? items.findIndex(item => {
          const existing = turnTimestamp(item.turnId)
          return Number.isFinite(existing) && existing > timestamp
        })
      : -1
    if (insertAt < 0) insertAt = items.length
  }
  const next = [...items]
  next.splice(insertAt, 0, message)
  return recentConversationMessages(next)
}

export function mergeConversationHistory(items, history = []) {
  const currentIds = new Set(items.map(message => message.id))
  const restored = history.flatMap(message => {
    const id = String(message.id || message.messageId || '')
    const content = String(message.content || '').trim()
    if (!id || !content || currentIds.has(id)) return []
    return [{
      id,
      role: message.role === 'user' ? 'user' : 'assistant',
      content,
      turnId: message.turnId || '',
      taskId: message.taskId || null,
      taskIds: message.taskIds || [],
      inputs: message.inputs || [],
      citations: message.citations || [],
      source: message.source || 'conversation-history',
      ...(message.source === 'agent-presentation'
        ? { origin: 'announcement' }
        : {}),
      createdAt: Number(message.createdAt) || 0,
      voice: message.source === 'voice-user',
      final: true,
      live: false,
    }]
  })
  return recentConversationMessages(
    [...restored, ...items],
    RECENT_CONVERSATION_MESSAGE_LIMIT,
  )
}

export function upsertUserTranscript(items, {
  id,
  content,
  turnId,
  final = false,
}) {
  const normalized = normalizeTranscript(content)
  if (!normalized) return items
  const message = {
    id,
    role: 'user',
    content: normalized,
    turnId,
    voice: true,
    final,
    live: !final,
  }
  const index = items.findIndex(item => item.id === id)
  if (index < 0) return insertByTurn(items, message)
  // A final transcript is the immutable record of one Gateway turn. Any
  // later delta with the same id is a duplicate or protocol error, not a new
  // utterance that may replace it.
  if (items[index].final) return items
  const next = [...items]
  next[index] = { ...next[index], ...message }
  return next
}

export function upsertAssistantTranscript(items, {
  id,
  content,
  turnId,
  taskId,
  taskIds,
  origin,
  citations,
  final = false,
}) {
  const index = items.findIndex(item => item.id === id)
  if (index < 0) {
    return insertByTurn(items, {
      id,
      role: 'assistant',
      content: final ? finalAssistantContent(content) : content || '',
      turnId,
      taskId,
      taskIds,
      origin,
      ...(citations?.length ? { citations } : {}),
      live: !final,
    })
  }
  const next = [...items]
  const existing = next[index]
  next[index] = {
    ...existing,
    content: final
      ? finalAssistantContent(content, existing.content)
      : existing.content + (content || ''),
    turnId: turnId || existing.turnId,
    taskId: taskId || existing.taskId,
    taskIds: taskIds || existing.taskIds,
    origin: origin || existing.origin,
    ...(citations?.length ? { citations } : {}),
    live: !final,
  }
  return next
}

export function discardUserTranscript(items, turnId) {
  if (!turnId) return items
  const id = `user:${turnId}`
  return items.filter(item => item.id !== id || item.final)
}

export function buildConversationTimeline(messages, tasks) {
  return buildConversationTurns(messages, tasks).flatMap(turn => [
    ...turn.beforeActivities.map(value => ({ type: 'message', value })),
    ...turn.tasks.map(value => ({ type: 'task', value })),
    ...turn.afterActivities.map(value => ({ type: 'message', value })),
  ])
}

export function buildConversationTurns(messages, tasks) {
  const turns = []
  const byTurnId = new Map()
  const createTurn = (id, standalone = false) => {
    const turn = { id, standalone, messages: [], tasks: [] }
    turns.push(turn)
    if (!standalone) byTurnId.set(id, turn)
    return turn
  }

  messages.forEach(message => {
    const resolvedTurnId = message.turnId || ''
    const standalone = !resolvedTurnId
    const id = standalone ? `message:${message.id}` : resolvedTurnId
    const turn = standalone
      ? createTurn(id, true)
      : byTurnId.get(id) || createTurn(id)
    turn.messages.push(message)
  })

  tasks.forEach(task => {
    const id = task.turnId || `task:${task.id}`
    const turn = task.turnId
      ? byTurnId.get(id) || createTurn(id)
      : createTurn(id, true)
    turn.tasks.push(task)
  })

  const orderedTurns = turns.filter(turn => turn.messages.length)
  const taskOnlyTurns = turns
    .filter(turn => !turn.messages.length)
    .sort((left, right) => (
      (turnChronologicalTime(left) ?? Number.MAX_SAFE_INTEGER)
      - (turnChronologicalTime(right) ?? Number.MAX_SAFE_INTEGER)
    ))
  for (const turn of taskOnlyTurns) {
    const timestamp = turnChronologicalTime(turn)
    const insertAt = timestamp === null ? -1 : orderedTurns.findIndex(existing => {
      const existingTimestamp = turnChronologicalTime(existing)
      return existingTimestamp !== null && existingTimestamp > timestamp
    })
    if (insertAt < 0) orderedTurns.push(turn)
    else orderedTurns.splice(insertAt, 0, turn)
  }

  return orderedTurns.map(turn => {
    const taskIds = new Set(turn.tasks.map(task => task.id))
    const afterTaskCard = message => (
      ['progress', 'announcement'].includes(message.origin)
      && [
        ...(Array.isArray(message.taskIds) ? message.taskIds : []),
        message.taskId,
      ].some(taskId => taskIds.has(taskId))
    )
    return {
      ...turn,
      beforeActivities: turn.messages.filter(message => !afterTaskCard(message)),
      afterActivities: turn.messages.filter(afterTaskCard),
    }
  })
}

function turnChronologicalTime(turn) {
  const itemTimes = [
    ...turn.messages.map(item => Number(item.createdAt || 0)),
    ...turn.tasks.map(item => Number(item.createdAt || 0)),
  ].filter(value => value > 0)
  if (itemTimes.length) return Math.min(...itemTimes)
  const timestamp = turnTimestamp(turn.id)
  return Number.isFinite(timestamp) ? timestamp : null
}
