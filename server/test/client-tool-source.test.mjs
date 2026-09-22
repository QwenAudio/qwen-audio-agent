import assert from 'node:assert/strict'
import test from 'node:test'
import { ClientToolSource } from '../src/frontend/tools/client-tool-source.mjs'
import { ClientActionPort } from '../src/client/client-action-port.mjs'
import { desktopClientTools } from '../../web/src/desktop/client-tools.js'
import { performDesktopClientAction } from '../../web/src/desktop/desktop-hide.js'
import { createGatewaySessionHello } from '../../shared/protocol/gateway-client-protocol.mjs'

test('client tools are declared at handshake; malformed, duplicate and unnegotiated tools fail', () => {
  const hello = { tools: desktopClientTools, capabilities: ['client.tools'] }
  assert.equal(createGatewaySessionHello(hello).tools[0].name, 'enter_sleep')
  assert.throws(() => createGatewaySessionHello({ ...hello, capabilities: [] }))
  assert.throws(() => createGatewaySessionHello({ ...hello, tools: [...desktopClientTools, ...desktopClientTools] }))
  assert.throws(() => createGatewaySessionHello({ ...hello, tools: [{ ...desktopClientTools[0], inputSchema: { type: 'string' } }] }))
})

test('client catalog is connection-local, atomic, and cannot shadow host tools', async () => {
  const first = new ClientToolSource({ actions: {}, reservedNames: ['spawn_thinking'] })
  const second = new ClientToolSource({ actions: {} })
  first.configure(desktopClientTools)
  assert.equal(first.supportsAction('client.tool.enter_sleep'), true)
  assert.deepEqual(second.tools(), [])
  assert.throws(() => first.configure([{ ...desktopClientTools[0], name: 'spawn_thinking' }]), /Duplicate/)
  assert.equal(first.tools().length, 1)
  await first.close()
  assert.equal(first.supportsAction('client.tool.enter_sleep'), false)
})

test('Gateway forwards a client tool; the desktop owns the actual operation and validates arguments', async () => {
  let hidden = 0, source
  const pending = []
  const actions = new ClientActionPort({
    getCapabilities: () => ['client.tools'],
    capabilityForAction: name => source.supportsAction(name) ? 'client.tools' : null,
    send: event => pending.push(event),
  })
  source = new ClientToolSource({ actions })
  source.configure(desktopClientTools)
  const result = source.execute('enter_sleep', {})
  assert.equal(hidden, 0)
  const response = await performDesktopClientAction(pending[0], {
    desktop: true,
    bridge: { async enterHide() { hidden++; return { state: 'hidden' } } },
  })
  actions.receive({ type: 'client.action.result', event_id: 'result', request_event_id: pending[0].event_id, ...response })
  assert.deepEqual(await result, { state: 'hidden' })
  assert.equal(hidden, 1)
  assert.equal((await performDesktopClientAction({ ...pending[0], arguments: { unknown: true } }, {
    desktop: true, bridge: { enterHide() { hidden++ } },
  })).status, 'failed')
  assert.equal(hidden, 1)
  const disconnected = source.execute('enter_sleep', {})
  actions.close()
  assert.equal((await disconnected).error_code, 'client_action_disconnected')
})

test('text events cannot execute a registered handler even when their label matches', async () => {
  const { GatewayEventRouter, ClientEventDefinitionRegistry } = await import('../src/client/client-event-router.mjs')
  let calls = 0
  const router = new GatewayEventRouter({ registry: new ClientEventDefinitionRegistry({ definitions: [{
    name: 'desktop.presence.changed', schema: { safeParse: data => ({ success: true, data }) }, handle() { calls++ },
  }] }) })
  const result = await router.publish({ event_id: 'info', text: 'Hidden.', name: 'desktop.presence.changed' })
  assert.equal(calls, 0)
  assert.equal(result.delivery.mode, 'context')
})
