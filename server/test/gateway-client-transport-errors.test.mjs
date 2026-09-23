import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import WebSocket from 'ws'
import { attachGatewayClientTransport } from '../src/transport/gateway-client-transport.mjs'
import { createGatewaySessionHello } from '../../shared/protocol/gateway-client-protocol.mjs'

async function harness(t) {
  const server = createServer()
  let closed = 0
  const diagnostics = []
  const logger = { info() {}, debug() {}, warn: (...args) => diagnostics.push(args) }
  logger.child = () => logger
  const transport = attachGatewayClientTransport(server, {
    identityManager: { resolveUpgrade: () => ({ ownerId: 'transport-errors' }) },
    logger,
    frontendRuntime: {
      supportsImageInput: () => false,
      createSession: () => ({
        start() {}, handleClientEvent() {}, status: () => ({}),
        close: () => { closed += 1 },
      }),
    },
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await transport.close()
    await new Promise(resolve => server.close(resolve))
  })
  async function connect() {
    const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/realtime`)
    socket.on('error', () => {})
    await once(socket, 'open')
    t.after(() => socket.terminate())
    return socket
  }
  return { connect, diagnostics, closed: () => closed }
}

for (const payload of ['null', '[]', '1', 'true', '"text"', '{']) {
  test(`malformed client ${payload} closes only its connection`, async t => {
    const host = await harness(t)
    const bad = await host.connect()
    const ended = once(bad, 'close')
    bad.send(payload)
    const [code] = await ended
    assert.equal(code, payload === '{' ? 1007 : 1008)
    const healthy = await host.connect()
    const reply = once(healthy, 'message')
    healthy.send(JSON.stringify(createGatewaySessionHello({ capabilities: [] })))
    assert.equal(JSON.parse((await reply)[0]).type, 'session.ready')
    healthy.close()
  })
}

test('oversized WebSocket frames do not exit the Gateway or leak a runtime', async t => {
  const host = await harness(t)
  const bad = await host.connect()
  const ended = once(bad, 'close')
  bad.send(Buffer.alloc(20 * 1024 * 1024 + 1))
  await ended
  // The server close callback can follow the client close on a later tick.
  for (let i = 0; i < 100 && !host.closed(); i++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(host.closed(), 1)
  assert.equal(host.diagnostics[0]?.[1]?.code, 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH')
  const healthy = await host.connect()
  const reply = once(healthy, 'message')
  healthy.send(JSON.stringify(createGatewaySessionHello({ capabilities: [] })))
  assert.equal(JSON.parse((await reply)[0]).type, 'session.ready')
  healthy.close()
})
