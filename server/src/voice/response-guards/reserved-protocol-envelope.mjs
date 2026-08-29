// These envelopes are injected by Gateway-owned delivery paths. A model may
// consume them as context, but must never manufacture them as assistant output.
// Keep this list narrow: ordinary XML-like text is valid conversational content.
export const GATEWAY_RESERVED_ENVELOPES = Object.freeze([
  'permission_request',
  'background_work_progress',
  'restored_context',
])

const RESERVED_ENVELOPE_PATTERN = new RegExp(
  `<\\/?(?:${GATEWAY_RESERVED_ENVELOPES.join('|')})(?:\\s|>)`,
  'i',
)

export function containsReservedProtocolEnvelope(content) {
  return RESERVED_ENVELOPE_PATTERN.test(String(content || ''))
}

export const reservedProtocolEnvelopeGuard = Object.freeze({
  id: 'reserved-protocol-envelope',
  instructions: [
    '你刚才输出了只能由 Gateway 提供的内部事件格式；该内容无效，不代表真实状态或授权请求。',
    '请重新处理用户当前意图：需要实际执行时调用已注册的合适工具，否则自然回答。不要编造协议标签、标识或执行状态。',
  ].join(' '),
  matches({
    origin = 'model',
    failed = false,
    suppressed = false,
    transcript = '',
  } = {}) {
    if (origin !== 'model' || failed || suppressed) return false
    return containsReservedProtocolEnvelope(transcript)
  },
})
