import { createAgentDelivery } from './agent-delivery.mjs'

export const GatewaySystemEvent = Object.freeze({
  REALTIME_CONTENT_REJECTED: 'realtime.content_rejected',
})

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
})

/**
 * Converts one Gateway-owned semantic event into a provider-neutral delivery.
 * Provider errors and raw rejected content must never cross this boundary.
 */
export function createGatewaySystemEventDelivery(name, {
  id,
  causeEventId,
  correlation = {},
} = {}) {
  const definition = DEFINITIONS[name]
  if (!definition) throw new TypeError(`unknown Gateway system event: ${name}`)
  return createAgentDelivery({
    ...(id ? { id } : {}),
    ...(causeEventId ? { causeEventId } : {}),
    mode: 'respond',
    origin: 'gateway-system-event',
    text: definition.text,
    correlation: {
      ...correlation,
      eventName: name,
    },
    presentation: {
      instructions: definition.instructions,
      allowTools: false,
      contextTiming: 'immediate',
    },
  })
}
