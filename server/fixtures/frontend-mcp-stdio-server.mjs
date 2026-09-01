import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({
  name: 'frontend-mcp-stdio-fixture',
  version: '1.0.0',
})

server.registerTool('echo', {
  description: 'Echo the supplied text.',
  inputSchema: {
    text: z.string(),
  },
}, async ({ text }) => ({
  content: [{
    type: 'text',
    text: `${process.env.FIXTURE_PREFIX || 'echo'}:${text}`,
  }],
}))

await server.connect(new StdioServerTransport())
