import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js'

export class CockpitMcpTools {
  constructor({
    origin = 'http://127.0.0.1:3010',
    cockpitId = 'default',
  } = {}) {
    this.url = new URL('/mcp/backend', origin)
    this.url.searchParams.set('cockpitId', cockpitId)
    this.client = null
    this.connecting = null
    this.definitions = null
  }

  async list({ signal } = {}) {
    await this.start({ signal })
    if (!this.definitions) {
      const output = await this.client.listTools(undefined, { signal })
      this.definitions = Object.freeze((output.tools || []).map(tool => Object.freeze({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })))
    }
    return this.definitions
  }

  async start({ signal } = {}) {
    signal?.throwIfAborted()
    if (this.client) return this
    if (this.connecting) return this.connecting
    this.connecting = (async () => {
      const client = new Client({
        name: 'qwen-audio-agent-cockpit-agent',
        version: '1.0.0',
      })
      try {
        await client.connect(new StreamableHTTPClientTransport(this.url), { signal })
        signal?.throwIfAborted()
      } catch (error) {
        await client.close().catch(() => {})
        throw error
      }
      this.client = client
      return this
    })().finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  async call(name, args = {}, { signal } = {}) {
    await this.start({ signal })
    const output = await this.client.callTool({
      name,
      arguments: args,
    }, undefined, { signal })
    const content = (output.content || [])
      .filter(part => part.type === 'text')
      .map(part => part.text)
      .join('\n')
      .trim()
    if (output.isError) throw new Error(content || `Cockpit tool ${name} failed`)
    return {
      content: content || '座舱操作已完成',
      data: output.structuredContent || {},
    }
  }

  async close() {
    const client = this.client
    this.client = null
    this.definitions = null
    await client?.close()
  }
}
