import { createAgentDelivery } from './agent-delivery.mjs'

export const GatewaySystemEvent = Object.freeze({
  REALTIME_CONTENT_REJECTED: 'realtime.content_rejected',
  REMINDER_DUE: 'reminder.due',
})

const REMINDER_RECURRENCES = new Set([
  'once',
  'daily',
  'weekly',
  'weekdays',
])

function clean(value) {
  return String(value || '').trim()
}

function bounded(value, maxChars = 1_000) {
  return [...clean(value)].slice(0, maxChars).join('')
}

function escapeXml(value) {
  return clean(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function isoTimestamp(value) {
  if (value === null || value === undefined || value === '') return ''
  const timestamp = Number(value)
  const date = Number.isFinite(timestamp)
    ? new Date(timestamp)
    : new Date(String(value))
  return Number.isFinite(date.getTime()) ? date.toISOString() : ''
}

function reminderDueProjection(data = {}) {
  const source = Array.isArray(data.reminders)
    ? data.reminders
    : [data]
  const reminders = source.slice(0, 8).map(item => {
    const content = bounded(item?.content)
    if (!content) return null
    const recurrence = clean(item?.recurrence).toLowerCase()
    return {
      content,
      scheduledAt: isoTimestamp(item?.scheduledAt),
      recurrence: REMINDER_RECURRENCES.has(recurrence) ? recurrence : 'once',
      timeZone: bounded(item?.timeZone, 100),
    }
  }).filter(Boolean)
  if (!reminders.length) {
    throw new TypeError('reminder.due requires at least one reminder')
  }
  const reminderBlocks = reminders.flatMap(item => [
    '  <reminder>',
    `    <content>${escapeXml(item.content)}</content>`,
    ...(item.scheduledAt
      ? [`    <scheduled_at>${escapeXml(item.scheduledAt)}</scheduled_at>`]
      : []),
    `    <recurrence>${item.recurrence}</recurrence>`,
    ...(item.timeZone
      ? [`    <time_zone>${escapeXml(item.timeZone)}</time_zone>`]
      : []),
    '  </reminder>',
  ])
  return {
    text: [
      '<gateway_system_event type="reminder.due">',
      ...reminderBlocks,
      '</gateway_system_event>',
    ].join('\n'),
    instructions: [
      '这是已经到期的提醒，不是用户的新请求。',
      '自然、简短地提醒用户；不要调用工具，不要声称执行了后台任务，也不要朗读协议标签或元数据。',
    ].join(' '),
  }
}

const DEFINITIONS = Object.freeze({
  [GatewaySystemEvent.REALTIME_CONTENT_REJECTED]: Object.freeze({
    text: [
      '<gateway_system_event>',
      '上一轮内容无法回复，请换个话题。',
      '</gateway_system_event>',
    ].join('\n'),
    instructions: [
      '这是 Gateway 提供的系统事件，不是用户的新请求。',
      '用一句自然口语告知用户，不调用工具，不朗读协议标签，也不要猜测或补充具体原因。',
    ].join(' '),
  }),
  [GatewaySystemEvent.REMINDER_DUE]: Object.freeze({
    project: reminderDueProjection,
  }),
})

/**
 * Converts one Gateway-owned semantic event into a provider-neutral delivery.
 * Provider errors and raw rejected content must never cross this boundary.
 */
export function createGatewaySystemEventDelivery(name, {
  id,
  causeEventId,
  data = {},
  correlation = {},
} = {}) {
  const definition = DEFINITIONS[name]
  if (!definition) throw new TypeError(`unknown Gateway system event: ${name}`)
  const projection = typeof definition.project === 'function'
    ? definition.project(data)
    : definition
  return createAgentDelivery({
    ...(id ? { id } : {}),
    ...(causeEventId ? { causeEventId } : {}),
    mode: 'respond',
    origin: 'gateway-system-event',
    text: projection.text,
    correlation: {
      ...correlation,
      eventName: name,
    },
    presentation: {
      instructions: projection.instructions,
      allowTools: false,
      contextTiming: 'immediate',
    },
  })
}
