import { GatewayClientEvent } from '../../shared/realtime-events.mjs'

export function textMessageEvent(text) {
  const normalized = typeof text === 'string' ? text.trim() : ''
  if (!normalized) return null
  return {
    type: GatewayClientEvent.TEXT_MESSAGE,
    text: normalized,
  }
}

export function canSubmitText({
  text,
  gatewayConnected,
  ownershipBusy,
  outputActive,
  submitting,
}) {
  return Boolean(
    textMessageEvent(text)
    && gatewayConnected
    && !ownershipBusy
    && !outputActive
    && !submitting,
  )
}

export function matchesTextAcknowledgement(event, pendingText) {
  return Boolean(
    pendingText
    && event?.type === 'transcript.final'
    && event.role === 'user'
    && String(event.content || '').trim() === pendingText,
  )
}

export function draftAfterTextAcknowledgement(draft, pendingText) {
  return String(draft || '').trim() === pendingText ? '' : draft
}
