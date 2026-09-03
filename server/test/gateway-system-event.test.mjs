import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createGatewaySystemEventDelivery,
  GatewaySystemEvent,
} from '../src/delivery/gateway-system-event.mjs'

test('creates a provider-neutral and sanitized content rejection delivery', () => {
  const delivery = createGatewaySystemEventDelivery(
    GatewaySystemEvent.REALTIME_CONTENT_REJECTED,
    {
      id: 'recovery-1',
      correlation: { turnId: 'turn-recovery' },
    },
  )

  assert.equal(delivery.id, 'recovery-1')
  assert.equal(delivery.mode, 'respond')
  assert.equal(delivery.origin, 'gateway-system-event')
  assert.equal(delivery.correlation.eventName, 'realtime.content_rejected')
  assert.equal(delivery.correlation.turnId, 'turn-recovery')
  assert.match(delivery.text, /上一轮内容无法回复，请换个话题/u)
  assert.doesNotMatch(delivery.text, /DataInspection|provider|违规原文/iu)
  assert.equal(delivery.presentation.allowTools, false)
  assert.equal(delivery.presentation.contextTiming, 'immediate')
})

test('rejects unknown Gateway system events', () => {
  assert.throws(
    () => createGatewaySystemEventDelivery('provider.private_error'),
    /unknown Gateway system event/u,
  )
})
