import assert from 'node:assert/strict'
import test from 'node:test'
import {
  GATEWAY_READY_MESSAGE,
  notifyGatewayReady,
} from '../src/app/gateway-ready-notification.mjs'

test('notifies an Electron utility-process parent without duplicate IPC', () => {
  const parentMessages = []
  const ipcMessages = []
  const channel = notifyGatewayReady({
    origin: 'http://127.0.0.1:43127',
    instanceId: 'gateway-instance-1',
    parentPort: {
      postMessage: message => parentMessages.push(message),
    },
    send: message => ipcMessages.push(message),
  })

  assert.equal(channel, 'parentPort')
  assert.deepEqual(parentMessages, [{
    type: GATEWAY_READY_MESSAGE,
    origin: 'http://127.0.0.1:43127',
    instanceId: 'gateway-instance-1',
  }])
  assert.deepEqual(ipcMessages, [])
})

test('falls back to Node child-process IPC', () => {
  const messages = []
  const channel = notifyGatewayReady({
    origin: 'http://127.0.0.1:43127',
    parentPort: null,
    send: message => messages.push(message),
  })

  assert.equal(channel, 'ipc')
  assert.deepEqual(messages, [{
    type: GATEWAY_READY_MESSAGE,
    origin: 'http://127.0.0.1:43127',
  }])
})

test('does nothing when the Gateway has no parent control channel', () => {
  assert.equal(notifyGatewayReady({
    origin: 'http://127.0.0.1:43127',
    parentPort: null,
    send: null,
  }), null)
})
