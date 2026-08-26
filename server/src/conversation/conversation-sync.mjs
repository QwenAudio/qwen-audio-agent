import { projectFrontendConversation } from './frontend-conversation-projection.mjs'

function sessionKey(ownerId, sessionId) {
  return `${ownerId}\u0000${sessionId}`
}

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function speechKey(value) {
  return clean(value)
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, '')
}

function speechNgrams(value, size = 2) {
  const grams = new Set()
  for (let index = 0; index <= value.length - size; index += 1) {
    grams.add(value.slice(index, index + size))
  }
  return grams
}

function equivalentSpeech(left, right) {
  if (left === right) return true
  if (left.length < 8 || right.length < 8) return false
  const leftGrams = speechNgrams(left)
  const rightGrams = speechNgrams(right)
  const shorterSize = Math.min(leftGrams.size, rightGrams.size)
  if (!shorterSize) return false
  let shared = 0
  for (const gram of leftGrams) {
    if (rightGrams.has(gram)) shared += 1
  }
  // Delegated acknowledgements often add details around the same short action
  // preview. One third of the shorter message is enough to recognize that
  // paraphrase without suppressing a genuinely different update.
  return shared / shorterSize >= 1 / 3
}

export class ConversationSync {
  constructor({
    maxMessages = 100,
    maxSessions = 500,
    sessionTtlMs = 6 * 60 * 60 * 1000,
    onRecord = null,
  } = {}) {
    this.maxMessages = maxMessages
    this.maxSessions = maxSessions
    this.sessionTtlMs = sessionTtlMs
    this.sessions = new Map()
    this.sequence = 0
    this.onRecord = onRecord
  }

  configureRetention(options = {}) {
    Object.assign(this, options)
  }

  setRecordObserver(observer) {
    this.onRecord = typeof observer === 'function' ? observer : null
    return this
  }

  state(ownerId, sessionId) {
    this.prune()
    const key = sessionKey(ownerId, sessionId)
    let state = this.sessions.get(key)
    if (!state) {
      this.enforceSessionLimit()
      state = { messages: [], byId: new Map(), lastAccessedAt: Date.now() }
      this.sessions.set(key, state)
    }
    state.lastAccessedAt = Date.now()
    return state
  }

  peek(ownerId, sessionId) {
    const state = this.sessions.get(sessionKey(ownerId, sessionId))
    if (state) state.lastAccessedAt = Date.now()
    return state || null
  }

  prune(now = Date.now()) {
    this.sessions.forEach((state, key) => {
      if (now - state.lastAccessedAt >= this.sessionTtlMs) this.sessions.delete(key)
    })
  }

  enforceSessionLimit() {
    while (this.sessions.size >= this.maxSessions) {
      const oldest = [...this.sessions.entries()]
        .sort((a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt)[0]
      if (!oldest) break
      this.sessions.delete(oldest[0])
    }
  }

  upsert({
    ownerId,
    sessionId,
    id,
    role,
    content,
    source,
    turnId = null,
    taskId = null,
    taskIds = [],
    inputs = [],
    citations = [],
    createdAt = null,
  }, { notify = true } = {}) {
    const normalized = clean(content)
    if (!id || !normalized) return null
    const state = this.state(ownerId, sessionId)
    const existing = state.byId.get(id)
    if (existing) {
      Object.assign(existing, {
        role,
        content: normalized,
        source,
        turnId,
        taskId,
        taskIds: [...new Set((taskIds || []).filter(Boolean))],
        inputs: (inputs || []).map(input => ({ ...input })),
      })
      if (citations?.length) {
        existing.citations = citations.map(citation => ({ ...citation }))
      }
      const snapshot = { ...existing }
      if (notify) {
        try { this.onRecord?.(snapshot, { ownerId, sessionId }) } catch { /* observers must not affect sync */ }
      }
      return snapshot
    }
    const message = {
      seq: ++this.sequence,
      id,
      role,
      content: normalized,
      source,
      turnId,
      taskId,
      taskIds: [...new Set((taskIds || []).filter(Boolean))],
      inputs: (inputs || []).map(input => ({ ...input })),
      ...(citations?.length
        ? { citations: citations.map(citation => ({ ...citation })) }
        : {}),
      createdAt: Number(createdAt) || Date.now(),
    }
    state.messages.push(message)
    state.byId.set(id, message)
    while (state.messages.length > this.maxMessages) {
      const removed = state.messages.shift()
      state.byId.delete(removed.id)
    }
    const snapshot = { ...message }
    if (notify) {
      try { this.onRecord?.(snapshot, { ownerId, sessionId }) } catch { /* observers must not affect sync */ }
    }
    return snapshot
  }

  record(message) {
    return this.upsert(message)
  }

  restore({ ownerId, sessionId, messages = [] }) {
    for (const message of messages) {
      this.upsert({ ownerId, sessionId, ...message }, { notify: false })
    }
    return this.frontendContext({ ownerId, sessionId })
  }

  list({ ownerId, sessionId }) {
    this.prune()
    return (this.peek(ownerId, sessionId)?.messages || [])
      .map(message => ({
        ...message,
        inputs: (message.inputs || []).map(input => ({ ...input })),
        ...(message.citations
          ? { citations: message.citations.map(citation => ({ ...citation })) }
          : {}),
      }))
  }

  hasEquivalentAssistantSpeech({
    ownerId,
    sessionId,
    turnId,
    content,
  }) {
    const target = speechKey(content)
    if (!target) return false
    return this.list({ ownerId, sessionId }).some(message => (
      message.role === 'assistant'
      && message.turnId === turnId
      && equivalentSpeech(speechKey(message.content), target)
    ))
  }

  frontendContext({ ownerId, sessionId }) {
    return projectFrontendConversation(this.list({ ownerId, sessionId }))
  }

}

export const conversationSync = new ConversationSync()
