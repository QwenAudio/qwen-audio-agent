// Scenario-owned business infrastructure. This service projects cockpit state
// to the UI and exposes scoped MCP tools, but it is not part of the Gateway or
// an additional qwen-audio-agent layer.
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import {
  StreamableHTTPServerTransport,
} from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createAmapCockpitServices } from './integrations/amap/services.mjs'
import { CockpitService } from './cockpit-service.mjs'
import { createCockpitMcpServer } from './mcp-server.mjs'
import { loadCockpitEnvironment } from '../bootstrap/environment.mjs'
import {
  BACKEND_TOOL_DEFINITIONS,
  FRONTEND_TOOL_DEFINITIONS,
} from './tools/registry.mjs'

const MAX_JSON_BYTES = 64 * 1024

function cockpitId(request, url, body = {}) {
  return String(
    request.headers['x-cockpit-id']
    || url.searchParams.get('cockpitId')
    || body.cockpitId
    || 'default',
  )
}

function json(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  })
  response.end(body)
}

async function readJson(request) {
  let total = 0
  const chunks = []
  for await (const chunk of request) {
    total += chunk.length
    if (total > MAX_JSON_BYTES) throw new Error('Request body is too large')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export class CockpitServiceServer {
  constructor({
    service = new CockpitService({ services: createAmapCockpitServices() }),
    host = '127.0.0.1',
    port = 3010,
  } = {}) {
    this.service = service
    this.host = host
    this.port = port
    this.server = null
    this.sockets = new Set()
  }

  get origin() {
    if (!this.server?.listening) return null
    const address = this.server.address()
    return `http://${this.host}:${address.port}`
  }

  async start() {
    if (this.server?.listening) return this
    const server = createServer((request, response) => {
      this.#handle(request, response).catch(error => {
        if (!response.headersSent) json(response, 500, { error: error.message })
        else response.end()
      })
    })
    server.on('connection', socket => {
      this.sockets.add(socket)
      socket.once('close', () => this.sockets.delete(socket))
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.port, this.host, resolve)
    })
    this.server = server
    return this
  }

  async close() {
    if (!this.server) return
    const server = this.server
    this.server = null
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    await new Promise(resolve => server.close(resolve))
  }

  async #handle(request, response) {
    const url = new URL(request.url || '/', `http://${this.host}`)
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'content-type, x-cockpit-id, mcp-protocol-version, mcp-session-id',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      })
      response.end()
      return
    }
    if (url.pathname === '/health' && request.method === 'GET') {
      json(response, 200, { ok: true, service: 'cockpit-service' })
      return
    }
    if (url.pathname === '/api/cockpit/state' && request.method === 'GET') {
      json(response, 200, this.service.snapshot(cockpitId(request, url)))
      return
    }
    if (url.pathname === '/api/cockpit/events' && request.method === 'GET') {
      this.#events(request, response, cockpitId(request, url))
      return
    }
    if (url.pathname === '/api/cockpit/skills' && request.method === 'GET') {
      json(response, 200, await this.service.listSkills(cockpitId(request, url)))
      return
    }
    const skillMatch = url.pathname.match(/^\/api\/cockpit\/skills\/([^/]+)$/u)
    if (skillMatch && request.method === 'GET') {
      const skill = await this.service.getSkill(
        cockpitId(request, url),
        decodeURIComponent(skillMatch[1]),
      )
      json(response, skill ? 200 : 404, skill || { error: 'Skill not found' })
      return
    }
    if (skillMatch && request.method === 'DELETE') {
      const skill = await this.service.deleteSkill(
        cockpitId(request, url),
        decodeURIComponent(skillMatch[1]),
      )
      json(response, skill ? 200 : 404, skill || { error: 'Skill not found' })
      return
    }
    if (url.pathname === '/api/cockpit/commands' && request.method === 'POST') {
      const body = await readJson(request)
      const output = await this.service.execute(body.name, body.arguments || {}, {
        cockpitId: cockpitId(request, url, body),
      })
      json(response, 200, output)
      return
    }
    if (url.pathname === '/api/cockpit/reset' && request.method === 'POST') {
      const body = await readJson(request)
      json(response, 200, this.service.reset(cockpitId(request, url, body)))
      return
    }
    const mcpTools = url.pathname === '/mcp/frontend'
      ? FRONTEND_TOOL_DEFINITIONS
      : url.pathname === '/mcp/backend'
        ? BACKEND_TOOL_DEFINITIONS
        : null
    if (mcpTools && request.method === 'POST') {
      await this.#mcp(request, response, cockpitId(request, url), mcpTools)
      return
    }
    if (mcpTools) {
      json(response, 405, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: 'Method not allowed' },
      })
      return
    }
    json(response, 404, { error: 'Not found' })
  }

  #events(request, response, id) {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    })
    const send = (type, value) => {
      response.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`)
    }
    send('snapshot', this.service.snapshot(id))
    const unsubscribeState = this.service.subscribe(id, event => send('state', event))
    const unsubscribeActivity = this.service.subscribeActivity(
      id,
      event => send('activity', event),
    )
    const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15_000)
    heartbeat.unref?.()
    request.once('close', () => {
      clearInterval(heartbeat)
      unsubscribeState()
      unsubscribeActivity()
    })
  }

  async #mcp(request, response, id, tools) {
    const server = createCockpitMcpServer({
      service: this.service,
      cockpitId: id,
      tools,
    })
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    })
    await server.connect(transport)
    const cleanup = () => {
      transport.close().catch(() => {})
      server.close().catch(() => {})
    }
    response.once('close', cleanup)
    try {
      await transport.handleRequest(request, response)
    } finally {
      if (response.writableEnded) cleanup()
    }
  }
}

export async function startCockpitServiceServer(options = {}) {
  return new CockpitServiceServer(options).start()
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (entry === import.meta.url) {
  loadCockpitEnvironment()
  const server = await startCockpitServiceServer({
    host: process.env.COCKPIT_SERVICE_HOST || '127.0.0.1',
    port: Number(process.env.COCKPIT_SERVICE_PORT) || 3010,
  })
  console.log(`Cockpit service listening on ${server.origin}`)
  const close = async () => {
    await server.close()
    process.exit(0)
  }
  process.once('SIGINT', close)
  process.once('SIGTERM', close)
}
