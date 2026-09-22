import assert from 'node:assert/strict'
import test from 'node:test'
import { ClientActionPort } from '../../server/src/client/client-action-port.mjs'
import { ClientToolSource } from '../../server/src/frontend/tools/client-tool-source.mjs'
import { desktopClientTools } from '../../web/src/desktop/client-tools.js'
import { ToolCallHandler } from '../../server/src/frontend/tools/tool-call-handler.mjs'
import { performDesktopClientAction } from '../../web/src/desktop/desktop-hide.js'
import { DesktopPresence } from '../src/desktop-presence.mjs'
import { bindOrbShell, ORB_CHANNELS } from '../src/orb-shell.mjs'
import {
  GatewayClientCapability,
  GatewayClientProtocolEvent,
} from '../../shared/protocol/gateway-client-protocol.mjs'

async function checkSleepFlow({ surface, state, failHide = false }) {
  let surfaceMode = surface
  let rendererSurface = surface
  let rendererLifecycle = state
  const window = {
    hidden: false,
    isDestroyed: () => false,
    hide() {
      if (failHide) throw new Error('Native window hide failed')
      this.hidden = true
    },
    webContents: { send(_channel, event) {
      rendererLifecycle = event.state
      if (event.state === 'hidden') rendererSurface = 'orb'
    } },
  }
  const presence = new DesktopPresence({
    getWindow: () => window,
    globalShortcut: {
      register: () => true,
      unregister() {},
      unregisterAll() {},
    },
  })
  presence.state = state
  const handlers = new Map()
  const shell = bindOrbShell({
    ipc: {
      on() {}, removeListener() {},
      handle: (channel, handler) => handlers.set(channel, handler),
      removeHandler: channel => handlers.delete(channel),
    },
    getWindow: () => window,
    presence,
    onLoadSurface: () => surfaceMode,
    onSetSurface: mode => {
      assert.equal(window.hidden, true, 'native hide must precede resizing')
      surfaceMode = mode
    },
  })
  const outputs = []
  const results = []
  let sleeping = false
  let clientActions
  let clientTools
  clientActions = new ClientActionPort({
    getCapabilities: () => [GatewayClientCapability.CLIENT_TOOLS],
    capabilityForAction: name => clientTools.supportsAction(name) ? GatewayClientCapability.CLIENT_TOOLS : null,
    createEventId: () => 'evt_gateway_sleep',
    send: async event => {
      const result = await performDesktopClientAction(event, {
        desktop: true,
        bridge: {
          enterHide: async options => handlers.get(ORB_CHANNELS.enterHide)(
            { sender: window.webContents }, options,
          ),
        },
        onLifecycle: state => { sleeping = state === 'hidden' },
      })
      clientActions.receive({
        type: GatewayClientProtocolEvent.CLIENT_ACTION_RESULT,
        event_id: 'evt_client_sleep',
        request_event_id: event.event_id,
        ...result,
      })
    },
  })
  clientTools = new ClientToolSource({ actions: clientActions })
  clientTools.configure(desktopClientTools)
  const handler = new ToolCallHandler({
    ownerId: 'owner',
    sessionId: 'voice',
    getFrontend: () => ({
      sendFunctionOutput: async (...args) => outputs.push(args),
    }),
    getTurnId: () => 'turn-one',
    getTurnGeneration: () => 1,
    frontendToolSources: [clientTools],
    onToolResultReady: result => results.push(result),
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

  assert.equal(outputs.length, 1)
  assert.equal(results[0].failed, failHide)
  assert.deepEqual(handlers.get(ORB_CHANNELS.lifecycleLoad)({ sender: window.webContents }),
    failHide ? { state } : { state: 'hidden', reason: 'requested' })
  if (failHide) {
    assert.equal(window.hidden, false)
    assert.equal(presence.state, state)
    assert.equal(rendererLifecycle, state)
    assert.equal(surfaceMode, surface)
    assert.equal(rendererSurface, surface)
    assert.equal(sleeping, false)
    assert.equal(outputs[0][1].error_code, 'desktop_hide_failed')
    assert.equal(results[0].errorCode, 'desktop_hide_failed')
    assert.equal(outputs[0][3].createResponse, true)
  } else {
    assert.equal(window.hidden, true)
    assert.equal(presence.state, 'hidden')
    assert.equal(rendererLifecycle, 'hidden')
    assert.equal(surfaceMode, 'orb')
    assert.equal(rendererSurface, 'orb')
    assert.equal(sleeping, true)
    assert.equal(outputs[0][1].state, 'hidden')
    assert.equal(outputs[0][3].createResponse, false)
    assert.equal(presence.ready(), false, 'late readiness cannot override sleep')
  }
  shell.dispose()
}

for (const scenario of [
  { surface: 'orb', state: 'active' },
  { surface: 'orb', state: 'waking' },
  { surface: 'panel', state: 'active' },
  { surface: 'panel', state: 'waking' },
  { surface: 'panel', state: 'active', failHide: true },
]) {
  test(`enter_sleep through desktop IPC: ${JSON.stringify(scenario)}`, () => checkSleepFlow(scenario))
}
