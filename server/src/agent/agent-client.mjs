import { config } from '../core/config.mjs'
import { assertBackendPort } from '../backend/backend-port.mjs'
import { AgentError } from './backend-adapter.mjs'
import { createAcpBackendAdapter } from './acp-backend-factory.mjs'

export { AgentError }

export class AgentClient {
  constructor({ adapter } = {}) {
    this.adapter = assertBackendPort(adapter, { name: 'AgentClient adapter' })
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

  status(taskId, options = {}) {
    return this.adapter.status(taskId, options)
  }

  start(options = {}) {
    return this.adapter.start(options)
  }

  submit(work, options = {}) {
    return this.adapter.submit(work, options)
  }

  cancel(taskId, options = {}) {
    return this.adapter.cancel(taskId, options)
  }

  respondAuthorization(taskId, authorizationId, decision, options = {}) {
    return this.adapter.respondAuthorization(
      taskId,
      authorizationId,
      decision,
      options,
    )
  }

  respondInput(taskId, inputRequestId, response, options = {}) {
    return this.adapter.respondInput(taskId, inputRequestId, response, options)
  }

  subscribe(listener) {
    return this.adapter.subscribe(listener)
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
    return this.adapter.close()
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
  status: (taskId, options = {}) => config.agentProtocol
    ? requireAgent().status(taskId, options)
    : {
        enabled: false,
        ok: true,
        status: 'not_configured',
        code: 'NOT_CONFIGURED',
      },
  start: (options = {}) => requireAgent().start(options),
  submit: (work, options = {}) => requireAgent().submit(work, options),
  cancel: (taskId, options = {}) => requireAgent().cancel(taskId, options),
  respondAuthorization: (
    taskId,
    authorizationId,
    decision,
    options = {},
  ) => requireAgent().respondAuthorization(
    taskId,
    authorizationId,
    decision,
    options,
  ),
  respondInput: (
    taskId,
    inputRequestId,
    response,
    options = {},
  ) => requireAgent().respondInput(taskId, inputRequestId, response, options),
  subscribe: listener => requireAgent().subscribe(listener),
  canRecoverDelegatedWork: task => config.agentProtocol
    ? requireAgent().canRecoverDelegatedWork(task)
    : false,
  recoverDelegatedWork: (task, options = {}) =>
    requireAgent().recoverDelegatedWork(task, options),
  uiUrl: (options = {}) => requireAgent().uiUrl(options),
  close: () => sharedAgent ? sharedAgent.close() : Promise.resolve(),
}
