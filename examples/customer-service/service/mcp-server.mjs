import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { toolDefinitions } from './tools/registry.mjs'
import { DEFAULT_DOMAIN } from './state-store.mjs'

function errorResult(error) {
  return {
    content: [{ type: 'text', text: error?.message || String(error) }],
    isError: true,
  }
}

// 一个 surface 一个 MCP Server 实例。两者共享同一个 service，
// 差别只在 tools/list 返回的清单和 execute 时传下去的 surface。
export function createCustomerServiceMcpServer({
  service,
  sessionId = 'default',
  surface = 'backend',
  // 工具面按域挑。不传时用这一组进程的默认域（CS_DOMAIN）——
  // 而不是写死 retail，否则 CS_DOMAIN=airline 起的 service 会把
  // 零售工具列给航空客服。
  domain = DEFAULT_DOMAIN,
} = {}) {
  if (!service?.execute) throw new TypeError('MCP server requires a customer service')
  if (surface !== 'frontend' && surface !== 'backend') {
    throw new TypeError(`Unknown tool surface: ${surface}`)
  }
  const tools = toolDefinitions(surface, domain)
  const server = new Server({
    name: `qwen-audio-agent-customer-service-${surface}`,
    version: '1.0.0',
  }, { capabilities: { tools: {} } })

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))

  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      // 【面内校验，不能只靠 tools/list】客户端可以直接 call 一个没列出来的名字。
      // 少了这道检查，前台就能调到后台独有的写库工具 —— 白名单形同虚设。
      if (!tools.some(tool => tool.name === request.params.name)) {
        throw new Error(`Tool is not available on this MCP surface: ${request.params.name}`)
      }
      const output = await service.execute(
        request.params.name,
        request.params.arguments || {},
        { sessionId, surface },
      )
      return {
        content: [{ type: 'text', text: output.content }],
        structuredContent: {
          stateVersion: output.stateVersion,
          changed: output.changed,
          ...output.data,
        },
      }
    } catch (error) {
      return errorResult(error)
    }
  })

  return server
}
