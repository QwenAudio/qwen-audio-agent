// Collecting one interaction's message flow, so a failure can be located.
//
// The Gateway already logs a great deal, but the layers do not share an
// identifier, and the backend's JSON-RPC traffic is not kept anywhere. That
// combination is what makes a class of bugs expensive: a permission request
// delivered to the wrong task looks, from the outside, exactly like a model
// refusing to do something. This module keeps the events of a single
// interaction together so the difference is visible.
//
// It records, it does not judge. Anomaly detection lives in flow-anomalies.mjs
// and reads what this produced.
import { redactLogValue } from '../../../shared/logger.mjs'

export const FLOW_LAYERS = Object.freeze([
  'frontstage',
  'gateway',
  'backend',
  'delegated',
])

// Bounded on purpose. This runs inside a long-lived Gateway, and an
// observability aid that grows without limit is a worse bug than the ones it
// helps find.
export const DEFAULT_MAX_FLOWS = 50
export const DEFAULT_MAX_EVENTS_PER_FLOW = 500
// Long enough for a prompt or an answer to be recognisable, short enough that
// a full buffer stays a few megabytes. 200 was too tight: a coordinator prompt
// opens with instructions, so the reader saw boilerplate and never the request.
const DEFAULT_MAX_TEXT = 800

// The payload fields, kept whole up to a much larger bound. Truncating a prompt
// at 800 characters made scrolling the detail panel pointless: the rest was
// discarded at record time, not merely hidden. Only these few fields per event
// are ever this large, so the memory cost stays small while the thing a reader
// came to read is actually there.
const PAYLOAD_KEYS = new Set(['prompt', 'content', 'arguments'])
const DEFAULT_MAX_PAYLOAD_TEXT = 20_000

// Heartbeats, not information transfer. task.progress fires once a second for
// as long as a task runs and says nothing beyond "still alive", so recording it
// filled a 500-event buffer with 500 identical rows and evicted every event
// worth reading. Duration is already recoverable from the running and
// completed timestamps.
export const FLOW_HEARTBEAT_EVENTS = Object.freeze(new Set([
  'task.progress',
  'task.notification.pending',
]))

function clean(value) {
  return typeof value === 'string' ? value.trim() : ''
}

// Long transcripts and model output would dominate a timeline and are not what
// anyone reads it for. Keep enough to recognise the turn, drop the rest.
function truncate(value, limit) {
  const text = clean(value)
  if (!text || text.length <= limit) return text
  return `${text.slice(0, limit)}…(+${text.length - limit})`
}

function normalizeDetail(detail, maxText, maxPayloadText) {
  if (detail === null || detail === undefined) return undefined
  const redacted = redactLogValue(detail)
  if (typeof redacted === 'string') return truncate(redacted, maxText)
  if (typeof redacted !== 'object') return redacted
  const out = {}
  for (const [key, value] of Object.entries(redacted)) {
    const limit = PAYLOAD_KEYS.has(key) ? maxPayloadText : maxText
    out[key] = typeof value === 'string' ? truncate(value, limit) : value
  }
  return out
}

// How the interaction ended, in one word, for the list. Read from the last
// task event rather than tracked as state, so it cannot disagree with the
// timeline the page shows underneath it.
const OUTCOME_BY_EVENT = {
  'task.completed': 'completed',
  'task.failed': 'failed',
  'task.cancelled': 'cancelled',
  'task.running': 'running',
  'task.delegated': 'delegated',
  'task.accepted': 'queued',
}

function flowOutcome(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const outcome = OUTCOME_BY_EVENT[events[index].type]
    if (outcome) return outcome
  }
  return ''
}

export class FlowRecorder {
  constructor({
    maxFlows = DEFAULT_MAX_FLOWS,
    maxEventsPerFlow = DEFAULT_MAX_EVENTS_PER_FLOW,
    maxTextLength = DEFAULT_MAX_TEXT,
    maxPayloadTextLength = DEFAULT_MAX_PAYLOAD_TEXT,
    now = () => Date.now(),
  } = {}) {
    this.maxFlows = Math.max(1, maxFlows)
    this.maxEventsPerFlow = Math.max(1, maxEventsPerFlow)
    this.maxTextLength = Math.max(1, maxTextLength)
    this.maxPayloadTextLength = Math.max(this.maxTextLength, maxPayloadTextLength)
    this.now = now
    // Insertion-ordered, which is what makes the oldest flow cheap to evict.
    this.flows = new Map()
    this.listeners = new Set()
    // The backend knows an interaction by its coordinator run id, which is the
    // task id, while the frontstage knows it by the turn. Both appear together
    // on every task event, so the mapping can be learned rather than threaded
    // through the shared call path as an extra argument.
    this.aliases = new Map()
  }

  // Learning that `alias` means the same interaction as `flowId`. If events
  // already landed under the alias they are moved, so a page opened later sees
  // one timeline rather than two halves.
  alias(alias, flowId) {
    const from = clean(alias)
    const to = clean(flowId)
    if (!from || !to || from === to) return
    if (this.aliases.get(from) === to) return
    this.aliases.set(from, to)
    const stray = this.flows.get(from)
    if (!stray) return
    this.flows.delete(from)
    const target = this.flows.get(to)
    if (!target) {
      this.flows.set(to, {
        ...stray,
        flowId: to,
        events: stray.events.map(event => ({ ...event, flowId: to })),
      })
      return
    }
    target.events = [...target.events, ...stray.events.map(e => ({ ...e, flowId: to }))]
      .sort((a, b) => a.at - b.at)
      .slice(-this.maxEventsPerFlow)
    target.startedAt = Math.min(target.startedAt, stray.startedAt)
    target.updatedAt = Math.max(target.updatedAt || 0, stray.updatedAt || 0)
  }

  record({ flowId, layer, type, taskId, sessionId, detail } = {}) {
    const requested = clean(flowId)
    const id = this.aliases.get(requested) || requested
    const kind = clean(type)
    // Without a flow to belong to, or a name, an event cannot be placed on a
    // timeline. Dropping it beats storing something unreadable.
    if (!id || !kind) return null
    // A heartbeat would crowd out the events that explain a failure.
    if (FLOW_HEARTBEAT_EVENTS.has(kind)) return null

    const event = {
      flowId: id,
      at: this.now(),
      layer: FLOW_LAYERS.includes(layer) ? layer : 'gateway',
      type: kind,
      ...(clean(taskId) ? { taskId: clean(taskId) } : {}),
      ...(clean(sessionId) ? { sessionId: clean(sessionId) } : {}),
    }
    const normalized = normalizeDetail(
      detail,
      this.maxTextLength,
      this.maxPayloadTextLength,
    )
    if (normalized !== undefined) event.detail = normalized

    const flow = this.flows.get(id) || { flowId: id, startedAt: event.at, events: [] }
    // The session a turn belongs to, learned from the first event that names
    // one. This is what lets a conversation be read as a single timeline.
    if (!flow.sessionId && event.sessionId) flow.sessionId = event.sessionId
    flow.events.push(event)
    if (flow.events.length > this.maxEventsPerFlow) flow.events.shift()
    flow.updatedAt = event.at
    // Re-insert so the most recently active flow is last, and eviction takes
    // the least recently active one rather than merely the oldest to start.
    this.flows.delete(id)
    this.flows.set(id, flow)
    while (this.flows.size > this.maxFlows) {
      const oldest = this.flows.keys().next().value
      this.flows.delete(oldest)
    }

    for (const listener of this.listeners) {
      // One broken subscriber must not stop the others, and must never break
      // the request that produced the event.
      try {
        listener(event)
      } catch {
        // ignore
      }
    }
    return event
  }

  subscribe(listener) {
    if (typeof listener !== 'function') return () => {}
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  // Put events back that were read from disk. Deliberately not `record`: these
  // already happened, so their timestamps must be kept rather than stamped
  // anew, and subscribers must not be told about them as if they were live.
  restore(events) {
    for (const event of Array.isArray(events) ? events : []) {
      const id = clean(event?.flowId)
      const kind = clean(event?.type)
      if (!id || !kind || FLOW_HEARTBEAT_EVENTS.has(kind)) continue
      const flow = this.flows.get(id)
        || { flowId: id, startedAt: event.at || 0, events: [] }
      if (!flow.sessionId && event.sessionId) flow.sessionId = event.sessionId
      flow.events.push(event)
      if (flow.events.length > this.maxEventsPerFlow) flow.events.shift()
      flow.startedAt = Math.min(flow.startedAt || event.at || 0, event.at || 0)
      flow.updatedAt = Math.max(flow.updatedAt || 0, event.at || 0)
      this.flows.delete(id)
      this.flows.set(id, flow)
      while (this.flows.size > this.maxFlows) {
        this.flows.delete(this.flows.keys().next().value)
      }
    }
  }

  get(flowId) {
    const flow = this.flows.get(clean(flowId))
    if (!flow) return null
    return { ...flow, events: [...flow.events] }
  }

  // A conversation, as one timeline. Storage stays per turn so a long session
  // cannot overflow one flow's cap, but the events of a session are what a
  // reader needs together: the failures worth finding here are session-level,
  // where a permission from one turn arrives during another. Split into
  // separate timelines, cause and effect end up on different pages.
  getSession(sessionId) {
    const id = clean(sessionId)
    if (!id) return null
    const flows = [...this.flows.values()].filter(flow => flow.sessionId === id)
    if (flows.length === 0) return null
    const events = flows
      .flatMap(flow => flow.events)
      .sort((a, b) => a.at - b.at)
    return {
      sessionId: id,
      startedAt: events[0].at,
      updatedAt: events[events.length - 1].at,
      turnIds: [...new Set(events.map(event => event.flowId))],
      events,
    }
  }

  // Newest activity first, for the same reason the flow list is.
  sessions() {
    const seen = new Map()
    for (const flow of [...this.flows.values()].reverse()) {
      if (!flow.sessionId) continue
      const existing = seen.get(flow.sessionId)
      if (existing) {
        existing.turnCount += 1
        existing.eventCount += flow.events.length
        existing.startedAt = Math.min(existing.startedAt, flow.startedAt)
        existing.updatedAt = Math.max(existing.updatedAt, flow.updatedAt || 0)
        existing.failed = existing.failed
          || flow.events.some(e => e.detail?.status === 'failed')
        continue
      }
      seen.set(flow.sessionId, {
        sessionId: flow.sessionId,
        turnCount: 1,
        eventCount: flow.events.length,
        startedAt: flow.startedAt,
        updatedAt: flow.updatedAt || flow.startedAt,
        lastRequest: flow.events.find(e => e.type === 'user.said')?.detail?.text || '',
        // Whether anything in the conversation failed. A session that holds
        // only a delivered failure notice looks empty by event count, and
        // filtering by size would have discarded exactly the record worth
        // keeping.
        failed: flow.events.some(e => e.detail?.status === 'failed'),
      })
    }
    return [...seen.values()]
  }

  // Newest first: when something just went wrong, that is the one being looked
  // for.
  list() {
    return [...this.flows.values()].reverse().map(flow => ({
      flowId: flow.flowId,
      startedAt: flow.startedAt,
      updatedAt: flow.updatedAt,
      durationMs: Math.max(0, flow.updatedAt - flow.startedAt),
      eventCount: flow.events.length,
      taskIds: [...new Set(flow.events.map(e => e.taskId).filter(Boolean))],
      layers: [...new Set(flow.events.map(e => e.layer))],
      // A turn id says nothing about which interaction it was. The request and
      // how it ended are what someone actually recognises in a list.
      request: flow.events.find(e => e.type === 'user.said')?.detail?.text || '',
      outcome: flowOutcome(flow.events),
    }))
  }

  clear() {
    this.flows.clear()
  }
}

// A recorder that is switched off still has to be safe to call from every
// instrumented site, so callers never need a conditional.
export const NULL_FLOW_RECORDER = Object.freeze({
  record: () => null,
  alias: () => {},
  restore: () => {},
  subscribe: () => () => {},
  get: () => null,
  list: () => [],
  clear: () => {},
})

// Task events already carry everything needed; this only reshapes them, which
// is why the task layer itself needs no changes.
export function taskEventToFlowEvent(event) {
  const task = event?.task || {}
  const flowId = clean(task.flowId) || clean(task.turnId)
  if (!flowId) return null
  return {
    flowId,
    layer: task.kind === 'delegated' ? 'delegated' : 'gateway',
    type: clean(event.type),
    taskId: clean(task.id),
    sessionId: clean(task.sessionId),
    detail: {
      status: task.status,
      ...(task.kind ? { kind: task.kind } : {}),
      ...(event.authorization?.id ? { permissionId: event.authorization.id } : {}),
      ...(event.decision ? { decision: event.decision } : {}),
      ...(task.error ? { error: task.error } : {}),
    },
  }
}
