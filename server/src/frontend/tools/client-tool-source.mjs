import { GatewayClientToolsSchema } from '../../../../shared/protocol/gateway-client-protocol.mjs'
import { toolFailure } from './tool-result.mjs'

/** Connection-local tool catalog. Definitions and operations belong to the
 * client; Gateway owns discovery, invocation correlation and deadlines. */
export class ClientToolSource {
  constructor({ actions, reservedNames = [] }) {
    this.actions = actions
    this.reservedNames = new Set(reservedNames)
    this.catalog = new Map()
  }

  configure(definitions = []) {
    const tools = GatewayClientToolsSchema.parse(definitions)
    for (const tool of tools) {
      if (this.reservedNames.has(tool.name)) throw new Error(`Duplicate frontend tool: ${tool.name}`)
    }
    this.catalog = new Map(tools.map(tool => [tool.name, {
      name: tool.name,
      definition: { type: 'function', function: {
        name: tool.name, description: tool.description, parameters: tool.inputSchema,
      } },
      policy: { responseOnSuccess: tool.response_on_success || 'auto' },
    }]))
  }

  supportsAction(name) {
    return name.startsWith('client.tool.') && this.catalog.has(name.slice('client.tool.'.length))
  }

  describe() { return { key: 'client', label: 'Connected client tools' } }
  async initialize() {}
  tools() { return [...this.catalog.values()] }
  health() { return { status: 'ready' } }
  async close() { this.catalog.clear() }

  async execute(name, args, { signal } = {}) {
    if (!this.catalog.has(name)) return toolFailure('client_tool_unavailable', '客户端未提供此工具。')
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return toolFailure('invalid_arguments', '工具参数必须是对象。')
    }
    try {
      const result = await this.actions.request(`client.tool.${name}`, args, { signal })
      return result.output ?? { status: 'completed' }
    } catch (error) {
      return toolFailure(error.code || 'client_tool_failed', error.message, { retryable: true })
    }
  }
}
