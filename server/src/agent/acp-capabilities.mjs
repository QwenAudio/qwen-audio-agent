import { AgentError } from './backend-adapter.mjs'

const OPTIONAL_MCP_TRANSPORTS = new Set(['http', 'sse', 'acp'])

function clean(value) {
  return String(value || '').trim()
}

export function assertMcpServerCapabilities({
  label = 'Agent',
  capabilities = {},
  mcpServers = [],
} = {}) {
  const advertised = capabilities?.mcpCapabilities || {}
  const required = new Set(
    mcpServers
      .map(server => clean(server?.type).toLowerCase())
      .filter(type => OPTIONAL_MCP_TRANSPORTS.has(type)),
  )
  for (const transport of required) {
    if (advertised[transport] === true) continue
    throw new AgentError(
      `${label} ACP 未声明支持 ${transport.toUpperCase()} MCP，无法提供协调工具`,
      { status: 422, protocol: 'acp' },
    )
  }
}
