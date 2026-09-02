import assert from 'node:assert/strict'
import test from 'node:test'
import { ClientActionPort } from '../../server/src/client/client-action-port.mjs'
import { PresenceController } from '../../server/src/client/presence-controller.mjs'
import { ToolCallHandler } from '../../server/src/voice/tools/tool-call-handler.mjs'
import { performDesktopClientAction } from '../../web/src/desktop-hide.js'
import { DesktopPresence } from '../src/desktop-presence.mjs'
import {
  GatewayClientCapability,
  GatewayClientProtocolEvent,
} from '../../shared/gateway-client-protocol.mjs'

test('an enter_sleep tool call hides the desktop orb end to end', async () => {
  const window = {
    hidden: false,
    isDestroyed: () => false,
    hide() { this.hidden = true },
    webContents: { send() {} },
  }
  const presence = new DesktopPresence({
    getWindow: () => window,
    globalShortcut: {
      register: () => true,
      unregister() {},
      unregisterAll() {},
    },
  })
  const outputs = []
  let sleeping = false
  let clientActions
  clientActions = new ClientActionPort({
    getCapabilities: () => [GatewayClientCapability.CLIENT_ACTION_ENTER_SLEEP],
    createEventId: () => 'evt_gateway_sleep',
    send: async event => {
      const result = await performDesktopClientAction(event, {
        desktop: true,
        bridge: {
          enterHide: async () => ({ state: presence.hide('requested') }),
        },
      })
      clientActions.receive({
        type: GatewayClientProtocolEvent.CLIENT_ACTION_RESULT,
        event_id: 'evt_client_sleep',
        request_event_id: event.event_id,
        ...result,
      })
    },
  })
  const presenceController = new PresenceController({
    clientActions,
    onSleeping: () => { sleeping = true },
  })
  const handler = new ToolCallHandler({
    ownerId: 'owner',
    sessionId: 'voice',
    getFrontend: () => ({
      sendFunctionOutput: async (...args) => outputs.push(args),
    }),
    getTurnId: () => 'turn-one',
    getTurnGeneration: () => 1,
    getClientContext: () => ({ actions: ['desktop.presence.enter_sleep'] }),
    presenceController,
  })

  await handler.handle({
    call_id: 'call-sleep',
    name: 'enter_sleep',
    arguments: '{}',
  }, {
    turnId: 'turn-one',
    turnGeneration: 1,
  })
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.equal(window.hidden, true)
  assert.equal(presence.state, 'hidden')
  assert.equal(sleeping, true)
  assert.equal(outputs.length, 1)
  assert.equal(outputs[0][1].status, 'sleeping')
  assert.equal(outputs[0][3].createResponse, false)
})
