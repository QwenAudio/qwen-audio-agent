import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod'
import {
  BUILTIN_CLIENT_EVENT_DEFINITIONS,
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
      ...BUILTIN_CLIENT_EVENT_DEFINITIONS,
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
  const router = new GatewayEventRouter({ now: () => now })
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
  const router = new GatewayEventRouter({ now: () => now })
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
