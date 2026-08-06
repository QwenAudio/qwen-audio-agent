import { config } from '../core/config.mjs'
import { AgentError } from './backend-adapter.mjs'
import { AcpBackendAdapter } from './acp-backend-adapter.mjs'
import { backendDriver } from './backends/registry.mjs'
import {
  captureScreen,
  loadImageFile,
  screenCaptureSupported,
} from './screen-capture.mjs'
import { describeImage, visionDescriberAvailable } from './vision-describer.mjs'

export { AgentError }

export class AgentClient {
  constructor({
    protocol = config.agentProtocol,
    ownership = config.backendOwnership,
    permissionMode = config.backendPermissionMode,
    model,
    coordinatorAgent,
    timeoutMs = config.agentTimeoutMs,
    backends = {},
    sessionStatePath = config.backendSessionStatePath,
    acpClient,
    acpClientFactory,
    sessionToolServer,
    screenCapture = config.screenCapture,
    imageMaxDimension = config.imageMaxDimension,
    configDirectory = config.configDirectory,
    visionModel = config.visionModel,
    visionModelUrl = config.visionModelUrl,
    visionApiKey = process.env.DASHSCOPE_API_KEY || '',
  } = {}) {
    const driver = backendDriver(protocol)
    // The selected backend's option namespace (config defaults merged with
    // per-construction overrides) plus the two cross-cutting overrides. New
    // backends only need a config.backends entry; nothing to thread here.
    const backend = {
      ...(config.backends?.[driver.id] || {}),
      ...(backends?.[driver.id] || {}),
    }
    const options = {
      baseUrl: '',
      ...backend,
      model: model ?? backend.model,
      coordinatorAgent: coordinatorAgent ?? backend.coordinatorAgent,
    }
    const profile = driver.createProfile({
      protocol,
      root: config.root,
      permissionMode,
      ...options,
    })
    this.adapter = new AcpBackendAdapter({
      protocol,
      root: config.root,
      ownership,
      permissionMode,
      timeoutMs,
      ...options,
      profile,
      nativeDelegationAdapter:
        driver.createNativeDelegationAdapter?.(options) || null,
      sessionStatePath,
      // Only wired when the user enabled the capability and the platform can
      // deliver it. Without this, the image tool is never registered.
      ...(screenCapture && screenCaptureSupported()
        ? {
          viewImage: async input => {
            const image = String(input?.path || '').trim()
              ? await loadImageFile(input.path, {
                configDirectory,
                maxDimension: imageMaxDimension,
              })
              : await captureScreen({
                configDirectory,
                maxDimension: imageMaxDimension,
              })
            // With a vision model configured, the Agent receives a description
            // instead of pixels. ACP cannot switch models inside a Session, so
            // this is what lets the Agent itself stay on a text model.
            if (!visionDescriberAvailable({ visionModel, apiKey: visionApiKey })) {
              return image
            }
            const described = await describeImage(image, {
              visionModel,
              visionModelUrl,
              apiKey: visionApiKey,
              question: input?.reason,
            })
            return {
              ...image,
              description: described.text,
              describedBy: described.model,
            }
          },
        }
        : {}),
      ...(acpClient ? { client: acpClient } : {}),
      ...(acpClientFactory ? { clientFactory: acpClientFactory } : {}),
      ...(sessionToolServer ? { sessionToolServer } : {}),
    })
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

  cancelDelegatedWork(workId, options = {}) {
    if (!this.adapter.cancelDelegatedWork) {
      throw new AgentError('当前后台 Agent 不支持取消第三层 Session', {
        protocol: this.protocol,
      })
    }
    return this.adapter.cancelDelegatedWork(workId, options)
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

let sharedAgent = null

function requireAgent() {
  if (!sharedAgent) {
    if (!config.agentProtocol) {
      throw new AgentError('当前未配置后台 Agent', {
        protocol: '',
      })
    }
    sharedAgent = new AgentClient()
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
  runCoordinator: (message, options = {}) =>
    requireAgent().runCoordinator(message, options),
  respondPermission: (id, decision, options = {}) =>
    requireAgent().respondPermission(id, decision, options),
  cancelDelegatedWork: (workId, options = {}) =>
    requireAgent().cancelDelegatedWork(workId, options),
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
