import { GatewayTaskEvent } from '../../../shared/realtime-events.mjs'

const REPLAYABLE_TYPES = new Set(Object.values(GatewayTaskEvent))

export function isReplayableGatewayEvent(event) {
  return Boolean(event && REPLAYABLE_TYPES.has(event.type))
}

export class GatewayClientReplayBuffer {
  constructor({ limit = 512 } = {}) {
    this.limit = Math.max(1, Number(limit) || 512)
    this.sequence = 0
    this.events = []
  }

  append(event) {
    const recorded = Object.freeze({
      ...event,
      sequence: ++this.sequence,
    })
    this.events.push(recorded)
    if (this.events.length > this.limit) this.events.shift()
    return recorded
  }

  cursor() {
    return {
      earliestSequence: this.events[0]?.sequence || this.sequence,
      latestSequence: this.sequence,
    }
  }

  replay(afterSequence = 0, { limit = 50 } = {}) {
    const after = Math.max(0, Number(afterSequence) || 0)
    const pageSize = Math.min(200, Math.max(1, Number(limit) || 50))
    const { earliestSequence, latestSequence } = this.cursor()
    if (after > latestSequence) {
      const error = new Error('replay cursor is ahead of the current session')
      error.code = 'session_expired'
      throw error
    }
    if (this.events.length && after < earliestSequence - 1) {
      const error = new Error('replay cursor is older than the retained event window')
      error.code = 'sequence_expired'
      throw error
    }
    const available = this.events.filter(event => event.sequence > after)
    const events = available.slice(0, pageSize)
    return {
      events: events.map(event => ({ ...event })),
      earliestSequence,
      latestSequence,
      nextSequence: events.at(-1)?.sequence || after,
      hasMore: available.length > events.length,
    }
  }
}
