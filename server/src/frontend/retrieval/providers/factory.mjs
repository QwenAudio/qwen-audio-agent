import { McpWebSearchProvider } from './mcp.mjs'
import { BingWebSearchProvider } from './bing.mjs'
import { So360WebSearchProvider } from './so360.mjs'

export function createWebSearchProvider(config, options = {}) {
  const provider = String(config?.webSearchProvider || 'none').toLowerCase()
  if (provider === 'none') return null
  if (provider === 'bing') {
    return new BingWebSearchProvider(options)
  }
  if (provider === 'so360') {
    return new So360WebSearchProvider(options)
  }
  if (provider === 'mcp' || provider === 'bailian') {
    return new McpWebSearchProvider({
      url: config.webSearchMcpUrl,
      token: config.webSearchMcpToken,
      toolName: config.webSearchMcpTool,
      ...(provider === 'bailian'
        ? {
            key: 'bailian-mcp',
            label: 'Bailian Web Search MCP',
            requiresToken: true,
          }
        : {}),
      ...options,
    })
  }
  throw new Error(`不支持的 Web Search Provider：${provider}`)
}
