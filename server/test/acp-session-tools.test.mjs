import assert from 'node:assert/strict'
import { createConnection } from 'node:net'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
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
