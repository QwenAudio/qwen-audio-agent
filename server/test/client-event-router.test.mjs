import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod'
import { createAgentDelivery } from '../src/delivery/agent-delivery.mjs'
import { RealtimeFrontend } from '../src/voice/realtime-provider.mjs'
import { RealtimeAgentDeliveryRuntime } from '../src/voice/realtime-agent-delivery-runtime.mjs'
import {
  ClientEventDefinitionRegistry,
  ClientEventRoutingError,
  GatewayEventRouter,
} from '../src/client/client-event-router.mjs'

const source = Object.freeze({
  ownerId: 'owner-1',
  sessionId: 'voice-1',
  clientType: 'desktop',
  clientInstanceId: 'desktop-1',
})

test('self-contained events need no registry and names never select a handler', async () => {
  const router = new GatewayEventRouter()
  const message = { type: 'client.event.publish', event_id: 'visual-1', text: 'Camera is active.' }
  const active = await router.publish(message, { source })
  assert.equal(active.delivery.origin, 'client-event')
  assert.equal(active.delivery.mode, 'context')
  assert.equal(active.delivery.presentation.contextTiming, 'immediate')
  assert.equal((await router.publish(message, { source })).duplicate, true)
  for (const mode of ['context', 'respond', 'interrupt']) {
    const result = await router.publish({ ...message, event_id: mode, name: 'task.completed', delivery_hint: mode }, { source })
    assert.equal(result.delivery.mode, mode)
    assert.equal(result.delivery.origin, 'client-event')
    assert.equal(result.delivery.presentation.allowTools === true, mode !== 'context')
  }
  assert.deepEqual(router.latestEvents(), [])
  for (const extra of [{text: ''}, {text: 'x'.repeat(17000)}, {data: {}}, {delivery_hint: 'handle'}]) {
    await assert.rejects(router.publish({ ...message, event_id: 'invalid', ...extra }, { source }),
      error => error.code === 'client_event_invalid')
  }
})

test('changing optional labels cannot bypass text-event rate limits', async () => {
  const router = new GatewayEventRouter({ now: () => 1000 })
  for (let i = 0; i < 20; i++) {
    await router.publish({ event_id: `info-${i}`, name: `environment.label${i}`, text: 'Current state.' }, { source })
  }
  await assert.rejects(router.publish({ event_id: 'over-limit', name: 'new.namespace', text: 'State.' }, { source }),
    error => error.code === 'rate_limited')
})

test('environment event projection adds only model context, not a response or interruption', async () => {
  const sent = []
  const frontend = new RealtimeFrontend({ onEvent() {}, onError() {} })
  frontend.ready = true
  frontend.capabilities.acknowledgesConversationItems = false
  frontend.ws = { readyState: 1, send: value => sent.push(JSON.parse(value)) }
  const runtime = new RealtimeAgentDeliveryRuntime({ getFrontend: () => frontend })
  const router = new GatewayEventRouter()
  for (const state of ['active', 'inactive']) {
    const result = await router.publish({
      type: 'client.event.publish', event_id: `visual-${state}`,
      text: state === 'active' ? '已开启实时视觉输入' : '当前无法看到新的画面',
    }, { source })
    assert.equal((await runtime.deliver(result.delivery)).completed, true)
  }
  assert.deepEqual(sent.map(event => event.type), ['conversation.item.create', 'conversation.item.create'])
  assert.match(sent[1].item.content[0].text, /当前无法看到新的画面/)
})

const extensionDefinition = {
  name: 'desktop.presence.sleep_requested',
  schema: z.object({ reason: z.string().max(160).optional(), idle_ms: z.number().nonnegative().optional() }).strict(),
  retention: 'latest', route: 'context', maxBytes: 1024,
  rateLimit: { max: 4, windowMs: 10000 },
  project: event => createAgentDelivery({ id: event.id, causeEventId: event.id,
    mode: event.route, origin: 'test-extension', text: 'Client is idle.' }),
}
function extensionRouter(options = {}) {
  return new GatewayEventRouter({ registry: new ClientEventDefinitionRegistry({ definitions: [extensionDefinition] }), ...options })
}
function sleepEvent(overrides = {}) {
  return {
    type: 'client.event.publish',
    event_id: 'evt-sleep-1',
    name: 'desktop.presence.sleep_requested',
    data: { reason: 'idle', idle_ms: 60_000 },
    ...overrides,
  }
}

test('registers built-in and extension Client Event definitions', () => {
  const registry = new ClientEventDefinitionRegistry({
    definitions: [
      extensionDefinition,
      {
        name: 'vehicle.control.button_pressed',
        schema: z.object({ button: z.string().min(1) }).strict(),
        route: 'context',
      },
    ],
  })
  assert.equal(registry.get('desktop.presence.sleep_requested')?.route, 'context')
  assert.equal(registry.get('vehicle.control.button_pressed')?.route, 'context')
  assert.throws(() => registry.register({
    name: 'task.changed',
    schema: z.object({}),
  }), /reserved Client Event namespace/u)
})

test('validates, rate-limits and bounds Client Event payloads', async () => {
  let now = 1_000
  const router = extensionRouter({ now: () => now })
  await assert.rejects(
    router.publish(sleepEvent({ name: 'desktop.unknown.event' }), { source }),
    error => error instanceof ClientEventRoutingError
      && error.code === 'client_event_unsupported',
  )
  await assert.rejects(
    router.publish(sleepEvent({ data: { idle_ms: -1 } }), { source }),
    error => error.code === 'client_event_invalid',
  )
  await assert.rejects(
    router.publish(sleepEvent({ data: { reason: 'x'.repeat(2_000) } }), { source }),
    error => ['payload_too_large', 'client_event_invalid'].includes(error.code),
  )

  for (let index = 0; index < 4; index += 1) {
    await router.publish(sleepEvent({ event_id: `evt-rate-${index}` }), { source })
  }
  await assert.rejects(
    router.publish(sleepEvent({ event_id: 'evt-rate-5' }), { source }),
    error => error.code === 'rate_limited',
  )
  now += 10_001
  assert.equal((await router.publish(sleepEvent({ event_id: 'evt-rate-6' }), {
    source,
  })).accepted, true)
})

test('deduplicates by trusted source and retains only the latest event', async () => {
  let now = 1_000
  const router = extensionRouter({ now: () => now })
  const first = await router.publish(sleepEvent({
    delivery_hint: 'context',
    source: { ownerId: 'spoofed-owner', clientType: 'spoofed-client' },
  }), { source })
  assert.equal(first.event.route, 'context')
  assert.equal(first.delivery.mode, 'context')
  assert.equal(first.delivery.causeEventId, 'evt-sleep-1')
  assert.deepEqual(first.event.source, source)
  assert.equal(first.event.source.ownerId, 'owner-1')

  const duplicate = await router.publish(sleepEvent({ data: { reason: 'changed' } }), {
    source,
  })
  assert.equal(duplicate.duplicate, true)
  assert.equal(router.latestEvents()[0].data.reason, 'idle')

  now += 1
  const next = await router.publish(sleepEvent({
    event_id: 'evt-sleep-2',
    data: { reason: 'new' },
    // A client may never upgrade automatic sleep beyond its context-only
    // registered route.
    delivery_hint: 'interrupt',
  }), { source })
  assert.equal(next.event.route, 'context')
  assert.equal(next.delivery.mode, 'context')
  assert.equal(router.latestEvents().length, 1)
  assert.equal(router.latestEvents()[0].data.reason, 'new')
})

test('does not acknowledge or retain a Client Event whose handler fails', async () => {
  let attempts = 0
  const registry = new ClientEventDefinitionRegistry({
    definitions: [{
      name: 'hardware.sensor.changed',
      schema: z.object({ value: z.number() }).strict(),
      retention: 'latest',
      handle: () => {
        attempts += 1
        if (attempts === 1) throw new Error('temporary failure')
      },
    }],
  })
  const router = new GatewayEventRouter({ registry })
  const message = {
    event_id: 'evt-sensor-1',
    name: 'hardware.sensor.changed',
    data: { value: 1 },
  }
  await assert.rejects(router.publish(message, { source }), /temporary failure/u)
  assert.deepEqual(router.latestEvents(), [])
  assert.equal((await router.publish(message, { source })).duplicate, false)
  assert.equal(attempts, 2)
})

test('passes host-supplied deterministic effects to an extension handler', async () => {
  let handled = null
  const registry = new ClientEventDefinitionRegistry({
    definitions: [{
      name: 'vehicle.assistant_profile.selected',
      schema: z.object({ profile: z.enum(['brief']) }).strict(),
      handle(event, effects) {
        effects.setAssistantProfile(`profile:${event.data.profile}`)
      },
    }],
  })
  const router = new GatewayEventRouter({ registry })

  await router.publish({
    event_id: 'evt-profile-1',
    name: 'vehicle.assistant_profile.selected',
    data: { profile: 'brief' },
  }, {
    source,
    effects: {
      setAssistantProfile(profile) {
        handled = profile
      },
    },
  })

  assert.equal(handled, 'profile:brief')
})
