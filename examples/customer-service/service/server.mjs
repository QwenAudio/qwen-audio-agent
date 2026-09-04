// 场景自有的业务基础设施：把客服状态投影给 UI，并暴露两个 MCP 工具面。
// 它不属于 Gateway，也不是 qwen-audio-agent 的额外一层。
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import {
  StreamableHTTPServerTransport,
} from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CustomerService } from './service.mjs'
import { createCustomerServiceMcpServer } from './mcp-server.mjs'
import { loadServiceEnvironment } from '../bootstrap/environment.mjs'

const MAX_JSON_BYTES = 64 * 1024

function sessionOf(request, url, body = {}) {
  return String(
    request.headers['x-service-session']
    || url.searchParams.get('sessionId')
    || body.sessionId
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
    // 上限先于拼接生效：先 concat 再判断的话，一个超大请求已经进了内存。
    if (total > MAX_JSON_BYTES) throw new Error('Request body is too large')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

class CustomerServiceServer {
  constructor({ host = '127.0.0.1', port = 3110, service } = {}) {
    this.host = host
    this.port = port
    this.service = service || new CustomerService()
    this.server = createServer((request, response) => {
      this.#route(request, response).catch(error => {
        if (!response.headersSent) json(response, 500, { error: error.message })
      })
    })
  }

  get origin() {
    return `http://${this.host}:${this.port}`
  }

  async start() {
    await new Promise(resolve => this.server.listen(this.port, this.host, resolve))
    const address = this.server.address()
    if (address && typeof address === 'object') this.port = address.port
    return this
  }

  async close() {
    await new Promise(resolve => this.server.close(resolve))
  }

  async #route(request, response) {
    const url = new URL(request.url, this.origin)

    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers':
          'content-type, x-service-session, mcp-protocol-version, mcp-session-id',
      })
      response.end()
      return
    }

    if (url.pathname === '/health' && request.method === 'GET') {
      json(response, 200, { ok: true })
      return
    }

    // 业务状态投影面：给 UI 用。对话状态走 GCP，两条通道分离 ——
    // Gateway 不接收也不理解订单结构。
    if (url.pathname === '/api/service/state' && request.method === 'GET') {
      json(response, 200, this.service.snapshot(
        sessionOf(request, url), url.searchParams.get('domain') || undefined,
      ))
      return
    }

    if (url.pathname === '/api/service/events' && request.method === 'GET') {
      this.#events(request, response, sessionOf(request, url))
      return
    }

    if (url.pathname === '/api/service/reset' && request.method === 'POST') {
      const body = await readJson(request)
      const session = sessionOf(request, url, body)
      json(response, 200, { version: this.service.reset(session, body.domain) })
      return
    }

    // 切换到另一位客户。和 reset 的区别只在语义：
    //   reset        这一位客户的操作全部撤回，还是同一位
    //   new-customer 换一位客户，之前的交互都不算了
    // 实现上都是重建库；分成两个端点是为了界面能给出不同的提示 ——
    // new-customer 要额外说明「对话历史清不掉」。
    if (url.pathname === '/api/service/new-customer' && request.method === 'POST') {
      const body = await readJson(request)
      const session = sessionOf(request, url, body)
      json(response, 200, this.service.newCustomer(session, body.domain))
      return
    }

    const surface = url.pathname === '/mcp/frontend'
      ? 'frontend'
      : url.pathname === '/mcp/backend'
        ? 'backend'
        : null
    if (surface && request.method === 'POST') {
      await this.#mcp(request, response, sessionOf(request, url), surface)
      return
    }
    if (surface) {
      json(response, 405, { error: 'MCP surface accepts POST only' })
      return
    }

    json(response, 404, { error: 'Not found' })
  }

  #events(request, response, sessionId) {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    })
    const send = snapshot => {
      response.write(`data: ${JSON.stringify(snapshot)}\n\n`)
    }
    // 先推一次当前快照：新连上的 UI 不该等到下一次状态变化才有内容。
    send(this.service.snapshot(sessionId))
    const unsubscribe = this.service.subscribe(sessionId, send)
    request.once('close', unsubscribe)
  }

  async #mcp(request, response, sessionId, surface) {
    const server = createCustomerServiceMcpServer({
      service: this.service,
      sessionId,
      surface,
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

export async function startCustomerServiceServer(options = {}) {
  return new CustomerServiceServer(options).start()
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (entry === import.meta.url) {
  loadServiceEnvironment()
  const server = await startCustomerServiceServer({
    host: process.env.CS_SERVICE_HOST || '127.0.0.1',
    port: Number(process.env.CS_SERVICE_PORT) || 3110,
  })
  console.log(`Customer service listening on ${server.origin}`)
  const close = async () => {
    await server.close()
    process.exit(0)
  }
  process.once('SIGINT', close)
  process.once('SIGTERM', close)
}
