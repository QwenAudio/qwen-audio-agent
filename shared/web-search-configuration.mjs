// Pure configuration projection: safe to use from a standalone Agent without
// loading Gateway configuration files or preparing its runtime directories.
export function resolveWebSearchConfiguration(env = process.env) {
  const bailianMcpUrl = 'https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp'
  const explicitMcpUrl = String(env.QWEN_AUDIO_WEB_SEARCH_MCP_URL || '').trim()
  const dashscopeApiKey = String(env.DASHSCOPE_API_KEY || '').trim()
  const requestedProvider = String(env.QWEN_AUDIO_WEB_SEARCH_PROVIDER || '').trim().toLowerCase()
  const provider = requestedProvider || (explicitMcpUrl ? 'mcp' : 'so360')
  if (!['bailian', 'bing', 'mcp', 'none', 'parallel', 'so360'].includes(provider)) {
    throw new Error(
      '不支持的 Web Search Provider：'
      + `${provider}（可选 bailian、bing、mcp、none、parallel、so360）`,
    )
  }
  const usesBailianMcp = provider === 'bailian'
  if (provider === 'parallel') {
    // Never forward credentials or endpoint overrides saved for another MCP
    // service. Use the custom mcp route for authenticated search instead.
    return {
      provider,
      mcpUrl: 'https://search.parallel.ai/mcp',
      mcpToken: '',
      mcpTool: 'web_search',
    }
  }
  return {
    provider,
    mcpUrl: usesBailianMcp ? bailianMcpUrl : explicitMcpUrl,
    mcpToken: String(env.QWEN_AUDIO_WEB_SEARCH_MCP_TOKEN
      || (usesBailianMcp ? dashscopeApiKey : '')).trim(),
    mcpTool: String(env.QWEN_AUDIO_WEB_SEARCH_MCP_TOOL || '').trim()
      || (usesBailianMcp ? 'bailian_web_search' : 'web_search'),
  }
}
