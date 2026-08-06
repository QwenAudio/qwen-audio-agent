import assert from 'node:assert/strict'
import { createConnection } from 'node:net'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  ACP_IMAGE_TOOL_NAME,
  ACP_SESSION_TOOL_NAMES,
  AcpSessionToolServer,
} from '../src/agent/acp-session-tools.mjs'

test('serves the shared Session tools over authenticated stateless MCP', async () => {
  const server = new AcpSessionToolServer()
  const calls = []
  const registration = await server.register({
    listSessions: async input => {
      calls.push(['list', input])
      return { sessions: [{ session_id: 'one' }] }
    },
    startSession: async input => ({ status: 'started', ...input }),
    sendSession: async input => ({ status: 'started', ...input }),
    sessionStatus: async input => ({ status: 'running', ...input }),
    cancelSession: async input => ({ status: 'cancelled', ...input }),
  })
  assert.equal(new URL(registration.descriptor.url).pathname, '/mcp')
  assert.doesNotMatch(registration.descriptor.url, /[?&]token=|\/mcp\/.+/)
  const transport = new StreamableHTTPClientTransport(
    new URL(registration.descriptor.url),
    {
      requestInit: {
        headers: Object.fromEntries(
          registration.descriptor.headers.map(header => (
            [header.name, header.value]
          )),
        ),
      },
    },
  )
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(transport)
  const listed = await client.listTools()
  assert.deepEqual(
    listed.tools.map(tool => tool.name).sort(),
    [...ACP_SESSION_TOOL_NAMES].sort(),
  )
  const result = await client.callTool({
    name: 'qwen_audio_agent_sessions_list',
    arguments: { query: 'project' },
  })
  assert.deepEqual(calls, [['list', { query: 'project' }]])
  assert.equal(
    JSON.parse(result.content[0].text).sessions[0].session_id,
    'one',
  )
  assert.equal(registration.update({
    listSessions: async input => {
      calls.push(['updated-list', input])
      return { sessions: [{ session_id: 'two' }] }
    },
  }), true)
  const updated = await client.callTool({
    name: 'qwen_audio_agent_sessions_list',
    arguments: { query: 'updated-project' },
  })
  assert.deepEqual(calls.at(-1), [
    'updated-list',
    { query: 'updated-project' },
  ])
  assert.equal(
    JSON.parse(updated.content[0].text).sessions[0].session_id,
    'two',
  )
  await client.close()
  registration.release()
  assert.equal(registration.update({}), false)
  await server.close()
})

test('does not expose an MCP context without its bearer token', async () => {
  const server = new AcpSessionToolServer()
  const registration = await server.register({
    listSessions: async () => ({ sessions: [] }),
  })
  const response = await fetch(registration.descriptor.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      },
    }),
  })
  assert.equal(response.status, 404)
  registration.release()
  await server.close()
})

test('closes promptly even while an MCP socket remains connected', async () => {
  const server = new AcpSessionToolServer()
  const registration = await server.register({
    listSessions: async () => ({ sessions: [] }),
  })
  const target = new URL(registration.descriptor.url)
  const socket = createConnection({
    host: target.hostname,
    port: Number(target.port),
  })
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })

  await Promise.race([
    server.close(),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('MCP server close timed out')),
      500,
    )),
  ])
  await new Promise(resolve => {
    if (socket.destroyed) return resolve()
    socket.once('close', resolve)
  })
  assert.equal(socket.destroyed, true)
})

test('the image tool appears only when a viewImage context is supplied', async () => {
  const server = new AcpSessionToolServer()
  const context = {
    listSessions: async () => ({ sessions: [] }),
    startSession: async () => ({ status: 'started' }),
    sendSession: async () => ({ status: 'started' }),
    sessionStatus: async () => ({ status: 'running' }),
    cancelSession: async () => ({ status: 'cancelled' }),
  }
  const asked = []
  const registration = await server.register({
    ...context,
    viewImage: async input => {
      asked.push(input)
      return {
        base64: Buffer.from('png').toString('base64'),
        mimeType: 'image/png',
        path: '/tmp/shot.png',
        bytes: 3,
      }
    },
  })
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(
    new URL(registration.descriptor.url),
    {
      requestInit: {
        headers: Object.fromEntries(registration.descriptor.headers.map(
          header => [header.name, header.value],
        )),
      },
    },
  ))

  const listed = await client.listTools()
  const names = listed.tools.map(tool => tool.name)
  assert.ok(names.includes(ACP_IMAGE_TOOL_NAME))

  // Looking at the user's screen must stay outside the auto-approved set, so
  // that every call reaches the user as a permission request.
  assert.equal(ACP_SESSION_TOOL_NAMES.includes(ACP_IMAGE_TOOL_NAME), false)

  const result = await client.callTool({
    name: ACP_IMAGE_TOOL_NAME,
    arguments: { reason: 'read the error on screen' },
  })
  assert.deepEqual(asked, [{ reason: 'read the error on screen' }])
  const image = result.content.find(part => part.type === 'image')
  assert.equal(image.mimeType, 'image/png')
  assert.equal(Buffer.from(image.data, 'base64').toString(), 'png')
  // The path travels alongside the image so an Agent whose MCP client drops
  // image content can still read the file itself.
  const details = JSON.parse(
    result.content.find(part => part.type === 'text').text,
  )
  assert.equal(details.path, '/tmp/shot.png')

  await client.close()
  await server.close()
})

test('the image tool reports failures as tool errors', async () => {
  const server = new AcpSessionToolServer()
  const registration = await server.register({
    listSessions: async () => ({ sessions: [] }),
    startSession: async () => ({ status: 'started' }),
    sendSession: async () => ({ status: 'started' }),
    sessionStatus: async () => ({ status: 'running' }),
    cancelSession: async () => ({ status: 'cancelled' }),
    viewImage: async () => {
      throw new Error('找不到图片：/tmp/missing.png')
    },
  })
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(
    new URL(registration.descriptor.url),
    {
      requestInit: {
        headers: Object.fromEntries(registration.descriptor.headers.map(
          header => [header.name, header.value],
        )),
      },
    },
  ))
  const result = await client.callTool({
    name: ACP_IMAGE_TOOL_NAME,
    arguments: { path: '/tmp/missing.png', reason: 'check' },
  })
  assert.equal(result.isError, true)
  assert.match(JSON.parse(result.content[0].text).error, /找不到图片/)
  await client.close()
  await server.close()
})

test('the image tool says so when the backend model cannot see images', async () => {
  const server = new AcpSessionToolServer()
  const registration = await server.register({
    listSessions: async () => ({ sessions: [] }),
    startSession: async () => ({ status: 'started' }),
    sendSession: async () => ({ status: 'started' }),
    sessionStatus: async () => ({ status: 'running' }),
    cancelSession: async () => ({ status: 'cancelled' }),
    viewImage: async () => ({
      base64: Buffer.from('png').toString('base64'),
      mimeType: 'image/png',
      path: '/tmp/shot.png',
      bytes: 3,
      backendSeesImages: false,
    }),
  })
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(
    new URL(registration.descriptor.url),
    {
      requestInit: {
        headers: Object.fromEntries(registration.descriptor.headers.map(
          header => [header.name, header.value],
        )),
      },
    },
  ))
  const result = await client.callTool({
    name: ACP_IMAGE_TOOL_NAME,
    arguments: { reason: 'look' },
  })
  // Sending image bytes a model cannot read only invites a guessed answer.
  assert.equal(result.content.some(part => part.type === 'image'), false)
  const details = JSON.parse(
    result.content.find(part => part.type === 'text').text,
  )
  assert.match(details.note, /cannot receive images/)
  assert.equal(details.path, '/tmp/shot.png')
  await client.close()
  await server.close()
})
