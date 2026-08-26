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
  if (message.origin === 'announcement') {
    const sequence = Number(message.deliverySequence)
    const insertAt = Number.isFinite(sequence)
      ? items.findIndex(item => (
          item.origin === 'announcement'
          && Number(item.deliverySequence) > sequence
        ))
      : -1
    if (insertAt < 0) return [...items, message]
    const next = [...items]
    next.splice(insertAt, 0, message)
    return next
  }
  if (!message.turnId) return [...items, message]
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
  return next
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
  deliverySequence,
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
      deliverySequence,
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
    deliverySequence: deliverySequence || existing.deliverySequence,
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
  const timeline = messages.map(message => ({ type: 'message', value: message }))
  tasks.forEach(task => {
    let insertAt = -1
    if (task.turnId) {
      const matching = timeline
        .map((item, index) => (
          item.type === 'message' && item.value.turnId === task.turnId
            ? index
            : -1
        ))
        .filter(index => index >= 0)
      if (matching.length) insertAt = matching.at(-1) + 1
    }
    if (insertAt < 0) insertAt = timeline.length
    timeline.splice(insertAt, 0, { type: 'task', value: task })
  })
  return timeline
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
    const standalone = message.origin === 'announcement' || !message.turnId
    const id = standalone ? `message:${message.id}` : message.turnId
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

  return turns
    .map((turn, index) => ({ ...turn, sortKey: turnSortKey(turn, index) }))
    .sort((left, right) => left.sortKey - right.sortKey)
    .map(turn => ({
      ...turn,
      beforeActivities: turn.messages,
      afterActivities: [],
    }))
}

function turnSortKey(turn, fallback) {
  const timestamp = turnTimestamp(turn.id)
  if (Number.isFinite(timestamp)) return timestamp
  const itemTimes = [
    ...turn.messages.map(item => Number(item.createdAt || 0)),
    ...turn.tasks.map(item => Number(item.createdAt || 0)),
  ].filter(value => value > 0)
  return itemTimes.length ? Math.min(...itemTimes) : Number.MAX_SAFE_INTEGER + fallback
}
