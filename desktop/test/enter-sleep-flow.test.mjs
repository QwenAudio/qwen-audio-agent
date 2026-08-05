import assert from 'node:assert/strict'
import test from 'node:test'
import { ToolCallHandler } from '../../server/src/voice/tools/tool-call-handler.mjs'
import { applyDesktopClientState } from '../../web/src/desktop-hide.js'
import { DesktopPresence } from '../src/desktop-presence.mjs'

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
  let stateTransition
  const handler = new ToolCallHandler({
    ownerId: 'owner',
    sessionId: 'voice',
    getFrontend: () => ({
      sendFunctionOutput: async (...args) => outputs.push(args),
    }),
    getTurnId: () => 'turn-one',
    getTurnGeneration: () => 1,
    getClientContext: () => ({ states: ['sleeping'] }),
    requestClientState: state => {
      stateTransition = applyDesktopClientState({
        type: 'client.state',
        state,
      }, {
        desktop: true,
        bridge: {
          enterHide: async () => ({
            state: presence.hide('requested'),
          }),
        },
      })
    },
  })

  await handler.handle({
    call_id: 'call-sleep',
    name: 'enter_sleep',
    arguments: '{}',
  }, {
    turnId: 'turn-one',
    turnGeneration: 1,
  })
  await stateTransition

  assert.equal(window.hidden, true)
  assert.equal(presence.state, 'hidden')
  assert.equal(outputs.length, 1)
  assert.equal(outputs[0][1].status, 'sleeping')
  assert.equal(outputs[0][3].createResponse, false)
})
