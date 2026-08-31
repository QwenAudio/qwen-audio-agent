import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
function errorResult(error) {
  return {
    content: [{
      type: 'text',
      text: error?.message || String(error),
    }],
    isError: true,
  }
}

export function createCockpitMcpServer({
  domain,
  cockpitId = 'default',
  tools,
} = {}) {
  if (!domain?.execute) throw new TypeError('Cockpit MCP server requires a domain runtime')
  if (!Array.isArray(tools)) throw new TypeError('Cockpit MCP server requires a scoped tool list')
  const server = new Server({
    name: 'qwen-audio-agent-cockpit',
    version: '1.0.0',
  }, {
    capabilities: { tools: {} },
  })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools,
  }))
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      if (!tools.some(tool => tool.name === request.params.name)) {
        throw new Error(`Tool is not available on this MCP surface: ${request.params.name}`)
      }
      const output = await domain.execute(
        request.params.name,
        request.params.arguments || {},
        { cockpitId },
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
