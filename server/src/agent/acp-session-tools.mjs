import { randomUUID } from 'node:crypto'
import { createServer as createHttpServer } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  StreamableHTTPServerTransport,
} from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

export const ACP_SESSION_TOOL_SERVER = 'qwen_audio_agent'
export const ACP_SESSION_TOOL_NAMES = [
  'qwen_audio_agent_sessions_list',
  'qwen_audio_agent_session_start',
  'qwen_audio_agent_session_send',
  'qwen_audio_agent_session_status',
  'qwen_audio_agent_session_cancel',
]

function jsonResult(value, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  }
}

function errorResult(error) {
  return jsonResult({
    status: 'failed',
    error: error?.message || String(error),
  }, true)
}

function registerTools(server, context) {
  server.registerTool(
    'qwen_audio_agent_sessions_list',
    {
      title: 'List Agent Sessions',
      description: 'List existing project Sessions. Use this to find the exact Session when the user asks to continue previous work.',
      inputSchema: {
        query: z.string().optional(),
        directory: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async input => {
      try {
        return jsonResult(await context.listSessions(input))
      } catch (error) {
        return errorResult(error)
      }
    },
  )
  server.registerTool(
    'qwen_audio_agent_session_start',
    {
      title: 'Start Agent Session',
      description: 'Start a new project Session asynchronously. Send only the natural task text and an absolute project directory.',
      inputSchema: {
        prompt: z.string().min(1),
        directory: z.string().min(1),
        title: z.string().optional(),
      },
    },
    async input => {
      try {
        return jsonResult(await context.startSession(input))
      } catch (error) {
        return errorResult(error)
      }
    },
  )
  server.registerTool(
    'qwen_audio_agent_session_send',
    {
      title: 'Continue Agent Session',
      description: 'Continue an existing project Session asynchronously. Use the exact session_id and absolute project directory returned by the Session list.',
      inputSchema: {
        session_id: z.string().min(1),
        prompt: z.string().min(1),
        directory: z.string().min(1),
      },
    },
    async input => {
      try {
        return jsonResult(await context.sendSession(input))
      } catch (error) {
        return errorResult(error)
      }
    },
  )
  server.registerTool(
    'qwen_audio_agent_session_status',
    {
      title: 'Query Agent Session',
      description: 'Read the current status and latest known result of a delegated project Session.',
      inputSchema: {
        delegation_id: z.string().optional(),
        session_id: z.string().optional(),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async input => {
      try {
        return jsonResult(await context.sessionStatus(input))
      } catch (error) {
        return errorResult(error)
      }
    },
  )
  server.registerTool(
    'qwen_audio_agent_session_cancel',
    {
      title: 'Cancel Agent Session',
      description: 'Cancel a delegated project Session.',
      inputSchema: {
        delegation_id: z.string().optional(),
        session_id: z.string().optional(),
      },
    },
    async input => {
      try {
        return jsonResult(await context.cancelSession(input))
      } catch (error) {
        return errorResult(error)
      }
    },
  )
}

export class AcpSessionToolServer {
  constructor({
    host = '127.0.0.1',
    createServer = createHttpServer,
  } = {}) {
    this.host = host
    this.createServer = createServer
    this.server = null
    this.startPromise = null
    this.port = null
    this.contexts = new Map()
    this.sockets = new Set()
  }

  async start() {
    if (this.server?.listening) return
    if (this.startPromise) return this.startPromise
    this.startPromise = new Promise((resolve, reject) => {
      const server = this.createServer((req, res) => {
        this.handleRequest(req, res).catch(error => {
          if (res.headersSent) return res.end()
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32603, message: error.message },
          }))
        })
      })
      server.once('error', reject)
      server.on('connection', socket => {
        this.sockets.add(socket)
        socket.once('close', () => this.sockets.delete(socket))
      })
      server.listen(0, this.host, () => {
        this.server = server
        this.port = server.address().port
        resolve()
      })
    }).finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  async register(context) {
    await this.start()
    const token = randomUUID()
    this.contexts.set(token, context)
    let released = false
    return {
      descriptor: {
        type: 'http',
        name: ACP_SESSION_TOOL_SERVER,
        url: `http://${this.host}:${this.port}/mcp`,
        headers: [{
          name: 'Authorization',
          value: `Bearer ${token}`,
        }],
      },
      update: nextContext => {
        if (released || !this.contexts.has(token)) return false
        this.contexts.set(token, nextContext)
        return true
      },
      release: () => {
        released = true
        return this.contexts.delete(token)
      },
    }
  }

  async handleRequest(req, res) {
    const url = new URL(req.url || '/', `http://${this.host}`)
    const authorization = String(req.headers.authorization || '')
    const token = authorization.match(/^Bearer ([^\s]+)$/i)?.[1] || ''
    const context = this.contexts.get(token)
    if (
      url.pathname !== '/mcp'
      || !context
    ) {
      res.writeHead(404)
      res.end()
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405, {
        'Content-Type': 'application/json',
        Allow: 'POST',
      })
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: 'Method not allowed.' },
      }))
      return
    }
    const server = new McpServer({
      name: ACP_SESSION_TOOL_SERVER,
      version: '1.0.0',
    })
    registerTools(server, context)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    })
    await server.connect(transport)
    const cleanup = () => {
      transport.close().catch(() => {})
      server.close().catch(() => {})
    }
    res.once('close', cleanup)
    try {
      await transport.handleRequest(req, res)
    } finally {
      if (res.writableEnded) cleanup()
    }
  }

  async close() {
    this.contexts.clear()
    const server = this.server
    this.server = null
    this.port = null
    if (!server?.listening) return
    await new Promise(resolve => {
      server.close(resolve)
      for (const socket of this.sockets) socket.destroy()
      this.sockets.clear()
    })
  }
}
