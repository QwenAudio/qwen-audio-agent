import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AgentDeliveryMode,
  createAgentDelivery,
  isModelVisibleDelivery,
} from '../src/delivery/agent-delivery.mjs'
import {
  RealtimeAgentDeliveryRuntime,
} from '../src/voice/realtime-agent-delivery-runtime.mjs'

test('normalizes all provider-neutral AgentDelivery routing modes', () => {
  for (const mode of Object.values(AgentDeliveryMode)) {
    const delivery = createAgentDelivery({
      id: `delivery-${mode}`,
      causeEventId: 'event-1',
      mode,
      origin: 'test',
      text: mode === 'handle' ? '' : 'event text',
      correlation: { taskId: 'task-1' },
    })
    assert.equal(delivery.mode, mode)
    assert.equal(delivery.causeEventId, 'event-1')
    assert.equal(isModelVisibleDelivery(delivery), mode !== 'handle')
  }
  assert.throws(
    () => createAgentDelivery({ mode: 'urgent', text: 'x' }),
    /invalid AgentDelivery mode/u,
  )
})

test('projects handle, context, respond and interrupt without provider objects', async () => {
  const calls = []
  const frontend = {
    ready: true,
    injectDelivery: async (...args) => {
      calls.push(args)
      return { completed: true, route: args[3].route }
    },
  }
  const runtime = new RealtimeAgentDeliveryRuntime({
    getFrontend: () => frontend,
  })

  assert.deepEqual(await runtime.deliver({ mode: 'handle' }), {
    completed: true,
    handled: true,
    mode: 'handle',
  })
  for (const mode of ['context', 'respond', 'interrupt']) {
    const result = await runtime.deliver({
      id: `delivery-${mode}`,
      mode,
      origin: 'task',
      text: `${mode} text`,
      correlation: { taskId: 'task-1' },
    })
    assert.equal(result.route, mode)
  }
  assert.deepEqual(calls.map(call => call[3].route), [
    'context',
    'respond',
    'interrupt',
  ])
  assert.deepEqual(calls[0][2], { taskId: 'task-1' })
})

test('reports blocked delivery without touching the realtime frontend', async () => {
  let called = false
  const runtime = new RealtimeAgentDeliveryRuntime({
    getFrontend: () => ({
      ready: true,
      injectDelivery: async () => {
        called = true
      },
    }),
    isDeliveryBlocked: () => true,
  })
  const outcome = await runtime.deliver({ mode: 'respond', text: 'later' })
  assert.equal(outcome.blocked, true)
  assert.equal(called, false)
})
