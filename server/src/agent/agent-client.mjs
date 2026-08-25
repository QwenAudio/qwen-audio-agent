import { config } from '../core/config.mjs'
import { AgentError } from './backend-adapter.mjs'
import { createAcpBackendAdapter } from './acp-backend-factory.mjs'

export { AgentError }

export class AgentClient {
  constructor({ adapter } = {}) {
    if (!adapter || typeof adapter !== 'object') {
      throw new TypeError('AgentClient requires one backend adapter')
    }
    this.adapter = adapter
  }

  get protocol() {
    return this.adapter.protocol
  }

  get label() {
    return this.adapter.label
  }

  describe() {
    return this.adapter.describe()
  }

  async health() {
    try {
      return await this.adapter.health()
    } catch (error) {
      return { ok: false, error: error.message, protocol: this.protocol }
    }
  }

  status() {
    return this.adapter.status()
  }

  runCoordinator(message, options = {}) {
    return this.adapter.runCoordinator(message, options)
  }

  respondPermission(id, decision, options = {}) {
    if (!this.adapter.respondPermission) {
      throw new AgentError('当前后台 Agent 不支持权限确认', {
        protocol: this.protocol,
      })
    }
    return this.adapter.respondPermission(id, decision, options)
  }

  coordinatorUsesMcpInstructions() {
    return this.adapter.coordinatorUsesMcpInstructions?.() === true
  }

  cancelWork(workId, options = {}) {
    if (!this.adapter.cancelWork) {
      throw new AgentError('当前后台 Agent 不支持取消任务', {
        protocol: this.protocol,
      })
    }
    return this.adapter.cancelWork(workId, options)
  }

  queryDelegatedWork(workId, question, options = {}) {
    if (!this.adapter.queryDelegatedWork) {
      throw new AgentError('当前后台 Agent 不支持查询第三层 Session', {
        protocol: this.protocol,
      })
    }
    return this.adapter.queryDelegatedWork(workId, question, options)
  }

  canRecoverDelegatedWork(task) {
    return this.adapter.canRecoverDelegatedWork?.(task) === true
  }

  recoverDelegatedWork(task, options = {}) {
    if (!this.adapter.recoverDelegatedWork) {
      throw new AgentError('当前后台 Agent 不支持恢复第三层 Session', {
        protocol: this.protocol,
      })
    }
    return this.adapter.recoverDelegatedWork(task, options)
  }

  uiUrl(options = {}) {
    return this.adapter.uiUrl?.(options.ownerId) || Promise.resolve(null)
  }

  close() {
    return this.adapter.close?.() || Promise.resolve()
  }
}

export function createAgentClient(options = {}) {
  return new AgentClient({
    adapter: createAcpBackendAdapter(options),
  })
}

let sharedAgent = null

function requireAgent() {
  if (!sharedAgent) {
    if (!config.agentProtocol) {
      throw new AgentError('当前未配置后台 Agent', {
        protocol: '',
      })
    }
    sharedAgent = createAgentClient()
  }
  return sharedAgent
}

export const agent = {
  get enabled() {
    return Boolean(config.agentProtocol)
  },
  get protocol() {
    return config.agentProtocol || null
  },
  get label() {
    return config.agentProtocol ? requireAgent().label : '仅前台聊天'
  },
  describe: () => config.agentProtocol
    ? requireAgent().describe()
    : {
        enabled: false,
        protocol: null,
        kind: null,
        label: '仅前台聊天',
        status: 'not_configured',
        capabilities: {
          backendUi: false,
        },
      },
  health: () => config.agentProtocol
    ? requireAgent().health()
    : Promise.resolve({
        enabled: false,
        ok: true,
      status: 'not_configured',
    }),
  status: () => config.agentProtocol
    ? requireAgent().status()
    : {
        enabled: false,
        ok: true,
        status: 'not_configured',
        code: 'NOT_CONFIGURED',
      },
  runCoordinator: (message, options = {}) =>
    requireAgent().runCoordinator(message, options),
  respondPermission: (id, decision, options = {}) =>
    requireAgent().respondPermission(id, decision, options),
  coordinatorUsesMcpInstructions: () => (
    requireAgent().coordinatorUsesMcpInstructions()
  ),
  cancelWork: (workId, options = {}) =>
    requireAgent().cancelWork(workId, options),
  queryDelegatedWork: (workId, question, options = {}) =>
    requireAgent().queryDelegatedWork(workId, question, options),
  canRecoverDelegatedWork: task => config.agentProtocol
    ? requireAgent().canRecoverDelegatedWork(task)
    : false,
  recoverDelegatedWork: (task, options = {}) =>
    requireAgent().recoverDelegatedWork(task, options),
  uiUrl: (options = {}) => requireAgent().uiUrl(options),
  close: () => sharedAgent ? sharedAgent.close() : Promise.resolve(),
}
