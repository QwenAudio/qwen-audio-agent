function clean(value) {
  return String(value || '').trim()
}

function bounded(value, max = 300) {
  return clean(value).replace(/\s+/g, ' ').slice(0, max)
}

export function coordinatorKey(ownerId, protocol) {
  return `${protocol}:${encodeURIComponent(clean(ownerId) || 'personal')}:backend`
}

export function projectSessionKey(protocol, sessionId) {
  return `${protocol}:${clean(sessionId)}`
}

export function sessionSummary(session) {
  return {
    session_id: clean(session?.sessionId),
    title: bounded(session?.title, 160),
    directory: clean(session?.cwd),
    updated_at: clean(session?.updatedAt),
  }
}

export function applySessionMetadataUpdate(session, update) {
  if (!session || typeof session !== 'object' || !update) return false
  if (update.sessionUpdate === 'session_info_update') {
    if (Object.hasOwn(update, 'title')) {
      session.title = update.title === null ? '' : bounded(update.title, 160)
    }
    if (Object.hasOwn(update, 'updatedAt')) {
      session.updatedAt = update.updatedAt === null
        ? ''
        : bounded(update.updatedAt, 80)
    }
    return true
  }
  if (update.sessionUpdate === 'current_mode_update') {
    session.currentModeId = bounded(update.currentModeId, 100)
    return true
  }
  return false
}

function categoryForTool(update) {
  const hint = [
    update?.name,
    update?.title,
    JSON.stringify(update?.rawInput || {}),
  ].join(' ').toLowerCase()
  if (/image|draw|canvas|图片|图像|绘图/.test(hint)) return 'image'
  if (/search|web|fetch|browser|搜索|查询/.test(hint)) return 'search'
  if (/read|glob|grep|list|读取|查找/.test(hint)) return 'read'
  if (/write|edit|patch|写入|修改/.test(hint)) return 'write'
  return 'run'
}

export function activityFromUpdate(update, known = new Map()) {
  if (update?.sessionUpdate === 'agent_thought_chunk') {
    return {
      id: 'acp-thinking',
      kind: 'thinking',
      status: 'running',
    }
  }
  if (update?.sessionUpdate === 'session_info_update') {
    const title = bounded(update.title, 160)
    const updatedAt = bounded(update.updatedAt, 80)
    if (!title && !updatedAt) return null
    return {
      id: 'acp-session-info',
      kind: 'session',
      status: 'updated',
      ...(title ? { title } : {}),
      ...(updatedAt ? { updatedAt } : {}),
    }
  }
  if (update?.sessionUpdate === 'current_mode_update') {
    const mode = bounded(update.currentModeId, 100)
    if (!mode) return null
    return {
      id: 'acp-current-mode',
      kind: 'mode',
      status: 'updated',
      mode,
    }
  }
  if (update?.sessionUpdate === 'plan') {
    const entries = Array.isArray(update.entries) ? update.entries : []
    const completed = entries.filter(entry => entry?.status === 'completed').length
    const current = entries.find(entry => entry?.status === 'in_progress')
      || entries.find(entry => entry?.status === 'pending')
    return {
      id: 'acp-plan',
      kind: 'plan',
      status: current ? 'running' : 'completed',
      detail: bounded(current?.content || ''),
      completed,
      total: entries.length,
    }
  }
  if (!['tool_call', 'tool_call_update'].includes(update?.sessionUpdate)) {
    return null
  }
  const id = clean(update.toolCallId)
  const merged = {
    ...(known.get(id) || {}),
    ...update,
  }
  const activity = {
    id: id || null,
    kind: 'tool',
    tool: bounded(merged.name || merged.title, 100) || 'tool',
    label: bounded(
      merged.rawInput?.description
      || merged.title
      || '',
      160,
    ),
    status: merged.status || 'running',
    category: categoryForTool(merged),
    detail: bounded(
      merged.rawInput?.description
      || merged.rawInput?.query
      || merged.rawInput?.path
      || merged.rawInput?.command
      || '',
    ),
  }
  if (id && ['completed', 'failed'].includes(merged.status)) known.delete(id)
  else if (id) known.set(id, merged)
  return activity
}

/**
 * Fold ACP `agent_message_chunk` deltas into the current user-facing Agent
 * message. Thought chunks and tool updates are intentionally excluded: ACP
 * already gives them distinct update types, so adapters do not need to infer
 * whether protocol activity is suitable for speech.
 */
export function messageFromUpdate(update, streams = {}) {
  streams.byId ||= new Map()
  if (update?.sessionUpdate !== 'agent_message_chunk') {
    // ACP 1.x permits messageId to be omitted. In that case a non-message
    // update is the only portable boundary between two streamed messages.
    streams.anonymous = ''
    return null
  }
  if (update.content?.type !== 'text') return null
  const delta = String(update.content.text || '')
  if (!delta) return null
  const messageId = clean(update.messageId)
  if (messageId) {
    const message = `${streams.byId.get(messageId) || ''}${delta}`.slice(-4_000)
    streams.byId.delete(messageId)
    streams.byId.set(messageId, message)
    while (streams.byId.size > 8) {
      streams.byId.delete(streams.byId.keys().next().value)
    }
    return { message: message.trim(), messageId }
  }
  streams.anonymous = `${streams.anonymous || ''}${delta}`.slice(-4_000)
  return { message: streams.anonymous.trim(), messageId: null }
}

export function nativeToolOutput(value) {
  if (!value) return {}
  if (typeof value === 'string') {
    try {
      return nativeToolOutput(JSON.parse(value))
    } catch {
      return {}
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const parsed = nativeToolOutput(item)
      if (Object.keys(parsed).length) return parsed
    }
    return {}
  }
  if (typeof value !== 'object') return {}
  if (
    value.childSessionKey
    || value.sessionKey
    || value.sessionId
    || value.session_id
  ) return value
  const details = nativeToolOutput(value.details)
  if (Object.keys(details).length) return details
  for (const block of Array.isArray(value.content) ? value.content : []) {
    const parsed = nativeToolOutput(block?.text || block?.content || block)
    if (Object.keys(parsed).length) return parsed
  }
  return {}
}
