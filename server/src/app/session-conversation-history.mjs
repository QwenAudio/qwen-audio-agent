import { replaySession } from '../session/session-replay.mjs'
import { projectFrontendConversation } from '../conversation/frontend-conversation-projection.mjs'

/**
 * Adapts the durable, domain-neutral Session Journal to the in-memory
 * conversation projection. Neither the Realtime runtime nor UI clients need
 * to understand the journal's JSONL representation.
 */
export class SessionConversationHistory {
  constructor({
    conversationSync,
    sessionJournal,
    logger = null,
    limit,
  } = {}) {
    if (!conversationSync) throw new TypeError('conversationSync is required')
    if (!sessionJournal) throw new TypeError('sessionJournal is required')
    this.conversationSync = conversationSync
    this.sessionJournal = sessionJournal
    this.logger = logger
    this.limit = limit
    this.started = false
  }

  start() {
    if (this.started) return 0
    this.started = true
    const restored = this.restoreAll()
    this.conversationSync.setRecordObserver?.((message, context) => {
      this.append(message, context)
    })
    return restored
  }

  restoreAll() {
    if (typeof this.sessionJournal.readAllSync !== 'function') return 0
    let restored = 0
    for (const entry of this.sessionJournal.readAllSync()) {
      try {
        const replay = replaySession(entry.records)
        const ownerId = String(replay.header.ownerId || '')
        const sessionId = String(replay.header.sessionId || '')
        if (!ownerId || !sessionId) continue
        const messages = projectFrontendConversation(replay.messages, {
          limit: this.limit,
        })
        this.conversationSync.restore?.({ ownerId, sessionId, messages })
        restored += messages.length
      } catch (error) {
        this.logger?.warn('conversation_history.restore_failed', {
          path: entry.path,
          error,
        })
      }
    }
    return restored
  }

  append(message, context = {}) {
    if (!context.ownerId || !message?.id) return
    const pending = this.sessionJournal.append({
      ownerId: context.ownerId,
      sessionId: context.sessionId || 'main',
      event: {
        type: message.role === 'user' ? 'user/message' : 'assistant/message',
        turnId: message.turnId || null,
        taskId: message.taskId || null,
        source: message.source || 'conversation-sync',
        payload: {
          messageId: message.id,
          content: message.content,
          inputs: message.inputs || [],
          taskIds: message.taskIds || [],
          citations: message.citations || [],
        },
      },
    })
    pending?.catch?.(error => {
      this.logger?.warn('conversation_history.append_failed', {
        ownerId: context.ownerId,
        sessionId: context.sessionId || 'main',
        error,
      })
    })
  }

  async messages({ ownerId, sessionId }) {
    if (typeof this.sessionJournal.read !== 'function') {
      return this.conversationSync.frontendContext({ ownerId, sessionId })
    }
    const records = await this.sessionJournal.read(ownerId, sessionId)
    return projectFrontendConversation(
      replaySession(records, { sessionId }).messages,
      { limit: this.limit },
    )
  }

  close() {
    this.conversationSync.setRecordObserver?.(null)
    this.started = false
  }
}
