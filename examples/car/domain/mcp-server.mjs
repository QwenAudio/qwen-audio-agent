import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { COCKPIT_TOOL_DEFINITIONS } from './tool-catalog.mjs'

function errorResult(error) {
  return {
    content: [{
      type: 'text',
      text: error?.message || String(error),
    }],
    isError: true,
  }
}

export function createCockpitMcpServer({ domain, cockpitId = 'default' } = {}) {
  if (!domain?.execute) throw new TypeError('Cockpit MCP server requires a domain runtime')
  const server = new Server({
    name: 'qwen-audio-agent-cockpit',
    version: '1.0.0',
  }, {
    capabilities: { tools: {} },
  })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: COCKPIT_TOOL_DEFINITIONS,
  }))
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
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
