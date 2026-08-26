// DSH-inspired durable session events.  These events are facts, not diagnostic
// log lines: projections (UI, tasks, memory) must be able to rebuild from them.
export const SESSION_LOG_SCHEMA = 'qwaudio.session/v1'
export const SESSION_LOG_FORMAT_VERSION = 1

export const SessionEventType = Object.freeze({
  SESSION_START: 'session/start',
  SESSION_END: 'session/end',
  TURN_START: 'turn/start',
  TURN_END: 'turn/end',
  STEP_START: 'step/start',
  STEP_END: 'step/end',
  USER_MESSAGE: 'user/message',
  ASSISTANT_CHUNK: 'assistant/chunk',
  ASSISTANT_MESSAGE: 'assistant/message',
  TOOL_CALL: 'tool/call',
  TOOL_RESULT: 'tool/result',
  ERROR: 'error',
  INPUT_REGISTERED: 'qwaudio/input/registered',
  INPUT_CONSUMED: 'qwaudio/input/consumed',
  REALTIME_REQUEST: 'qwaudio/realtime/request',
  ACP_REQUEST: 'qwaudio/acp/request',
  ACP_UPDATE: 'qwaudio/acp/update',
  ACP_RESULT: 'qwaudio/acp/result',
  TASK_EVENT: 'qwaudio/task/event',
  DELIVERY_EVENT: 'qwaudio/delivery/event',
  MEMORY_EVENT: 'qwaudio/memory/event',
})

export function createSessionHeader({ sessionId, createdAt = new Date().toISOString(), ...meta } = {}) {
  if (!String(sessionId || '').trim()) throw new TypeError('sessionId is required')
  return {
    schema: SESSION_LOG_SCHEMA,
    type: 'session',
    version: SESSION_LOG_FORMAT_VERSION,
    sessionId: String(sessionId),
    createdAt,
    ...meta,
  }
}

export function normalizeSessionEvent(event, { sessionId, seq, time = new Date().toISOString() } = {}) {
  if (!event || typeof event !== 'object') throw new TypeError('session event must be an object')
  const type = String(event.type || '').trim()
  if (!type || type === 'session') throw new TypeError('session event type is required')
  if (!Number.isInteger(seq) || seq < 1) throw new TypeError('session event seq must be a positive integer')
  return Object.freeze({
    schema: SESSION_LOG_SCHEMA,
    ...event,
    sessionId: String(event.sessionId || sessionId || ''),
    seq,
    time: event.time || time,
    type,
  })
}

export function validateSessionLog(records, { sessionId } = {}) {
  if (!Array.isArray(records) || records.length === 0) throw new TypeError('session log is empty')
  const [header, ...events] = records
  if (header?.type !== 'session' || header.schema !== SESSION_LOG_SCHEMA) {
    throw new TypeError('invalid session log header')
  }
  if (sessionId && header.sessionId !== sessionId) throw new TypeError('session id mismatch')
  events.forEach((event, index) => {
    if (event.schema !== SESSION_LOG_SCHEMA || event.sessionId !== header.sessionId || event.seq !== index + 1) {
      throw new TypeError(`invalid session event at sequence ${index + 1}`)
    }
  })
  return { header, events }
}
