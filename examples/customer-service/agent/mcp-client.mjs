import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js'

// 后台 Agent 连的是 /mcp/backend —— 完整工具面。
// 前台连 /mcp/frontend 只拿到白名单子集，两者是同一份 executor 的两个入口。
export class ServiceMcpTools {
  constructor({
    origin = 'http://127.0.0.1:3110',
    sessionId = 'default',
  } = {}) {
    this.url = new URL('/mcp/backend', origin)
    this.url.searchParams.set('sessionId', sessionId)
    this.client = null
    this.connecting = null
    this.definitions = null
  }

  async list() {
    await this.start()
    if (!this.definitions) {
      const output = await this.client.listTools()
      this.definitions = Object.freeze((output.tools || []).map(tool => Object.freeze({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        // annotations 要带上来：executor 里 monetaryHint / destructiveHint
        // 决定这个动作要不要走 auth_required。丢了它，Agent 就分不出
        // 「查订单」和「退款」的区别。
        annotations: tool.annotations,
      })))
    }
    return this.definitions
  }

  async start() {
    if (this.client) return this
    if (this.connecting) return this.connecting
    this.connecting = (async () => {
      const client = new Client({
        name: 'qwen-audio-agent-customer-service-agent',
        version: '1.0.0',
      })
      await client.connect(new StreamableHTTPClientTransport(this.url))
      this.client = client
      return this
    })().finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  async call(name, args = {}, { signal } = {}) {
    await this.start()
    const output = await this.client.callTool({
      name,
      arguments: args,
    }, undefined, { signal })
    const content = (output.content || [])
      .filter(part => part.type === 'text')
      .map(part => part.text)
      .join('\n')
      .trim()
    // 【工具的业务拒绝不是异常】「超出退货时限」「订单不是 pending」这些
    // 都通过 isError=false + 文本返回，Agent 要读懂并转告客户。
    // 只有真正的执行失败才 isError=true。
    if (output.isError) throw new Error(content || `Customer service tool ${name} failed`)
    return {
      content: content || '操作已完成',
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
