import { registerGatewayHttpRoutes } from './gateway-http-routes.mjs'
import { optionalModuleFactories } from './optional-modules.mjs'
import { OperationAudit } from '../core/operation-audit.mjs'
import express from 'express'
import { createServer } from 'http'
import { randomUUID } from 'node:crypto'
import { resolve } from 'path'
import { agent as defaultAgent } from '../backend/adapters/agent-client.mjs'
import { BackendAvailability } from '../backend/availability.mjs'
import { BackendWorkRuntime } from '../backend/backend-work-runtime.mjs'
import { TaskOperations } from '../orchestration/task-operations.mjs'
import { config as defaultConfig } from '../core/config.mjs'
import { logger as defaultLogger } from '../core/logger.mjs'
import { conversationSync as defaultConversationSync } from '../conversation/conversation-sync.mjs'
import { InputAssetRegistry } from '../voice/input-asset-registry.mjs'
import { IdentityManager } from '../core/identity.mjs'
import { FrontendNotesStore } from '../conversation/frontend-notes.mjs'
import { SessionConversationHistory } from './session-conversation-history.mjs'
import { SessionDigestPool } from '../conversation/session-digest.mjs'
import { SessionSummariser } from '../conversation/session-summariser.mjs'
import {
  createOpenAiCompatibleTextCall,
} from '../core/llm/openai-compatible-chat.mjs'
import {
  GatewayAccessManager,
  GatewayDeviceRegistry,
  parseGatewayAccessKeys,
} from '../access/gateway-access.mjs'
import { GatewayPublicEndpointService } from '../access/gateway-public-endpoint.mjs'
import { attachGatewayClientTransport } from '../transport/gateway-client-transport.mjs'
import { createFrontendRuntime } from './frontend-runtime.mjs'
import {
  defaultRealtimeProviderRegistry,
} from '../voice/realtime-provider.mjs'
import { InputArbitration } from '../voice/input-arbitration.mjs'
import { PermissionPolicy } from '../task/permission-policy.mjs'
import { TaskManager } from '../task/task-manager.mjs'
import { TaskStore } from '../task/task-store.mjs'
import { SessionJournalRegistry } from '../session/session-journal-registry.mjs'
import { ReminderScheduler } from '../task/reminder-scheduler.mjs'
import { installOfflineNotifications } from './offline-notifications.mjs'
import {
  FrontendRetrievalRuntime,
} from '../frontend/retrieval/frontend-retrieval-runtime.mjs'
import { createWebSearchProvider } from '../frontend/retrieval/providers/factory.mjs'
import { assertFrontendToolSource } from '../frontend/tools/frontend-tool-source.mjs'
import { FrontendMcpClient } from '../frontend/tools/mcp/frontend-mcp-client.mjs'
import {
  loadFrontendMcpConfiguration,
} from '../frontend/tools/mcp/frontend-mcp-config.mjs'
import {
  FrontendOpenApiAdapter,
} from '../frontend/tools/openapi/frontend-openapi-adapter.mjs'
import {
  loadFrontendOpenApiConfiguration,
} from '../frontend/tools/openapi/frontend-openapi-config.mjs'
import { GatewayClientCommandRuntime } from '../client/client-command-runtime.mjs'
import {
  ClientEventDefinitionRegistry,
  GatewayEventRouter,
} from '../client/client-event-router.mjs'

export function createGatewayApplication({
  config = defaultConfig,
  agent = defaultAgent,
  backendRuntime = null,
  conversationSync = defaultConversationSync,
  inputAssets = null,
  taskManager = null,
  taskStore = null,
  logger = defaultLogger,
  parentPort = process.parentPort,
  autoStart = true,
  realtimeProviderRegistry = defaultRealtimeProviderRegistry,
  realtimeProvider = config.audioProvider,
  webSearchProvider = undefined,
  urlFetcher = undefined,
  frontendRetrieval = null,
  memoryProvider = undefined,
  frontendMemory = null,
  knowledgeProvider = null,
  // Compatibility alias for embedders that adopted the original injection name.
  knowledgeRetrievalProvider = null,
  frontendKnowledge = null,
  knowledgeRuntimeOptions = {},
  frontendMcp = undefined,
  frontendOpenApi = undefined,
  frontendToolSources: additionalToolSources = [],
  clientActionNames = [],
  sessionJournal = null,
  conversationHistory = null,
  taskAnnouncementFactory = undefined,
  clientCommandRuntime = null,
  clientEventRouter = null,
  clientEventDefinitions = [],
  spawnThinkingDescription = '',
  gatewayAccess = null,
  publicEndpoint = undefined,
  webrtc = undefined,
} = {}) {
const workBackend = backendRuntime || new BackendWorkRuntime({ backend: agent })
const sessionJournalRuntime = sessionJournal || new SessionJournalRegistry({
  directory: resolve(config.stateDirectory, 'sessions'), logger,
})
taskStore ||= taskManager?.repository?.store || new TaskStore({
  filePath: config.taskStatePath,
  onWarning: warning => logger.warn('task.persistence_warning', { warning }),
})
taskManager ||= new TaskManager({
  store: taskStore, logger, sessionJournal: sessionJournalRuntime,
  maxConcurrent: config.taskMaxConcurrent,
  maxConcurrentPerOwner: config.taskMaxConcurrentPerOwner,
  terminalTtlMs: config.taskTerminalTtlMs,
  pendingNotificationTtlMs: config.taskPendingNotificationTtlMs,
  maxTerminalTasksPerOwner: config.maxTerminalTasksPerOwner,
  scheduledTaskTimeoutMs: config.scheduledTaskTimeoutMs,
})
const permissionPolicy = new PermissionPolicy({
  taskManager,
  ttlMs: config.conversationSessionTtlMs,
  maxSessions: config.maxConversationSessions,
})
const respondAuthorization = (taskId, id, decision, options) => (
  agent.respondAuthorization(taskId, id, decision, options)
)
const taskOperations = new TaskOperations({
  taskManager,
  backendRuntime: workBackend,
  permissionPolicy,
  respondAuthorization,
  respondInput: (taskId, id, response, options) => agent.respondInput(taskId, id, response, options),
})
const conversationHistoryRuntime = conversationHistory || new SessionConversationHistory({
  conversationSync,
  sessionJournal: sessionJournalRuntime,
  logger,
})
const restoredConversationMessages = conversationHistoryRuntime.start?.() || 0
if (restoredConversationMessages) {
  logger.info('conversation_history.restored', {
    messages: restoredConversationMessages,
  })
}
const inputAssetRegistry = inputAssets || new InputAssetRegistry({
  sessionTtlMs: config.conversationSessionTtlMs,
  maxSessions: config.maxConversationSessions,
})
const retrievalRuntime = frontendRetrieval || new FrontendRetrievalRuntime({
  searchProvider: webSearchProvider === undefined
    ? createWebSearchProvider(config)
    : webSearchProvider,
  ...(urlFetcher === undefined ? {} : { urlFetcher }),
})
const frontendMcpRuntime = frontendMcp === undefined
  ? new FrontendMcpClient({
      configuration: loadFrontendMcpConfiguration({
        filePath: config.frontendMcpConfigPath || '',
      }),
      logger,
    })
  : frontendMcp
const frontendOpenApiRuntime = frontendOpenApi === undefined
  ? new FrontendOpenApiAdapter({
      configuration: loadFrontendOpenApiConfiguration({
        filePath: config.frontendOpenApiConfigPath || '',
      }),
    })
  : frontendOpenApi
// TaskManager remains the owner of task state. The journal receives an
// immutable event copy so recovery and replay do not depend on its in-memory
// Map or on the current task projection.
const unsubscribeSessionTaskJournal = taskManager.subscribe(event => {
  const task = event?.task
  if (!task?.id) return
  sessionJournalRuntime.append({
    ownerId: event.ownerId || task.ownerId,
    sessionId: task.sessionId || 'main',
    event: {
      type: 'qwaudio/task/event',
      eventId: event.eventId || randomUUID(),
      turnId: task.turnId || null,
      taskId: task.id,
      source: 'task-manager',
      payload: {
        domainType: event.type,
        task,
        details: Object.fromEntries(
          Object.entries(event).filter(([key]) => !['type', 'ownerId', 'task'].includes(key)),
        ),
      },
    },
  })
}, { scope: 'all' })
const frontendToolSources = [
  frontendMcpRuntime,
  frontendOpenApiRuntime,
  ...additionalToolSources,
].filter(Boolean).map(source => assertFrontendToolSource(source))
const identityManager = new IdentityManager({
  secret: config.authSecret,
  mode: config.identityMode,
  personalOwnerId: config.personalOwnerId,
})
const gatewayAccessRuntime = gatewayAccess || new GatewayAccessManager({
  identityManager,
  secret: config.authSecret,
  configuredKeys: parseGatewayAccessKeys({
    accessToken: config.gatewayAccessToken,
    accessKeys: config.gatewayAccessKeys,
    personalOwnerId: config.personalOwnerId,
  }),
  deviceRegistry: new GatewayDeviceRegistry({
    filePath: config.gatewayDeviceStatePath,
    onWarning: warning => logger.warn('gateway_access.persistence_warning', { warning }),
  }),
  personalOwnerId: config.personalOwnerId,
})
// 麦克风抢占控制面：外部宿主（输入法、平台应用）需要录音时通过
// /api/input/suspend 宣告，Gateway 责成所有客户端停采；持有过期自动恢复。
const inputArbitration = new InputArbitration({ logger })
taskManager.configureRetention({
  terminalTtlMs: config.taskTerminalTtlMs,
  pendingNotificationTtlMs: config.taskPendingNotificationTtlMs,
  notificationClaimTtlMs: config.taskNotificationClaimTtlMs,
  maxTerminalTasksPerOwner: config.maxTerminalTasksPerOwner,
})
// Recover records missing from the compact task snapshot by replaying the
// latest task projection found in durable Session Journals.
const restoredJournalTasks = taskManager.sessionJournal === sessionJournalRuntime
  ? 0
  : taskManager.restoreFromJournal(sessionJournalRuntime)
if (restoredJournalTasks) {
  logger.info('session_journal.tasks_restored', { count: restoredJournalTasks })
}
taskManager.recoverDelegated({
  canRecover: task => agent.canRecoverDelegatedWork(task),
  runner: (task, context) => agent.recoverDelegatedWork(task, context),
  canceler: async (task, { abort }) => {
    const result = await agent.cancel(task.id, {
      ownerId: task.ownerId,
    })
    abort()
    return result
  },
})
// Offline notification subscriber: if a voice session does not claim a
// pending notification within the delay window, deliver via desktop
// notification (Electron) and WebSocket push.
const unsubscribeOfflineNotifications = installOfflineNotifications({
  taskManager,
  parentPort,
  delayMs: config.offlineNotificationDelayMs,
})
conversationSync.configureRetention({
  sessionTtlMs: config.conversationSessionTtlMs,
  maxSessions: config.maxConversationSessions,
})
// Restored scheduled tasks submit the same self-contained Work input as live
// requests. Frontend conversation history and memory stay at the frontend.
taskManager.configureScheduledTaskRunner(
  (objective, context) => taskOperations.runScheduled(objective, context),
)
// ReminderScheduler: setTimeout-driven, no polling. Handles overdue
// stagger on restart and re-arming after each fire.
let reminderScheduler = null
if (config.reminderSchedulerEnabled) {
  reminderScheduler = new ReminderScheduler({
    taskManager,
    staggerMs: config.reminderStaggerMs,
    logger,
  })
  reminderScheduler.start()
}
const notesStore = new FrontendNotesStore({
  filePath: config.frontendNotesPath,
  maxOwners: config.maxFrontendMemoryOwners,
  ownerTtlMs: config.frontendMemoryOwnerTtlMs,
  onWarning: warning => logger.warn('notes.persistence_warning', { warning }),
})
// Audit and stateless text calls are shared infrastructure for independent
// memory learning, conversation summaries and document summaries.
const operationAudit = new OperationAudit({
  filePath: config.memoryAuditPath,
  onWarning: warning => logger.warn('background.audit_warning', { warning }),
})
// 后台轻量分析共用一套文本模型调用；没有 API key 时为 null，依赖它的
// 记忆学习、会话摘要和资料摘要模块各自静默禁用，本地纯语音链路不受影响。
const textModelCall = config.memoryAutoEnabled
  ? createOpenAiCompatibleTextCall({
      baseUrl: config.memoryBaseUrl,
      apiKey: config.memoryApiKey,
      model: config.memoryModel,
    })
  : null
const optionalModules = optionalModuleFactories.map(create => create({
  config, logger, conversationSync, textModelCall, audit: operationAudit,
  workBackend, agent, backendRuntime, taskManager,
  memoryProvider, frontendMemory, knowledgeProvider, knowledgeRetrievalProvider,
  frontendKnowledge, knowledgeRuntimeOptions,
}))
const optionalServices = Object.assign({}, ...optionalModules.map(module => module.services))
const {
  frontendMemory: frontendMemoryRuntime = null,
  frontendKnowledge: frontendKnowledgeRuntime = null,
} = optionalServices
// 会话摘要：只记「聊了哪些话题 + 一句要点」，是 recall 工具的唯一
// 数据来源。刻意不注入 instructions —— 这类数据每场都在变，注进去会让 prompt
// 前缀每场都变、前缀缓存大面积失效。没有 API key 时摘要器为 null，池子空转，
// 工具也不会暴露给模型。
let sessionDigests = null
let sessionSummariser = null
if (config.sessionDigestEnabled) {
  sessionDigests = new SessionDigestPool({
    filePath: config.sessionDigestPath,
    onWarning: warning => logger.warn('session_digest.persistence_warning', { warning }),
  })
  sessionSummariser = textModelCall
    ? new SessionSummariser({
        digestPool: sessionDigests,
        conversationSync,
        audit: operationAudit,
        llmCall: textModelCall,
        logger,
        // 把本场派过的活沉淀进摘要。排除 control（「查一下那个任务的进展」这个
        // 动作本身）与 reminder（未来要做的事，不属于「做过什么」）。
        // 只取 objective 与 id，状态留给检索时实时读 —— 摘要里存状态会冻结。
        listSessionWork: ({ ownerId, sessionId }) => taskManager
          .list({ ownerId, sessionId })
          .filter(task => task.kind === 'work' || task.kind === 'scheduled_task')
          .map(task => ({ id: task.id, objective: task.objective })),
      })
    : null
}
const app = express()
const runtimeCommands = clientCommandRuntime || new GatewayClientCommandRuntime({
  taskManager,
  taskOperations,
  conversationHistory: conversationHistoryRuntime,
  logger,
})
const gatewayEventRouter = clientEventRouter || new GatewayEventRouter({
  registry: new ClientEventDefinitionRegistry({
    definitions: clientEventDefinitions,
  }),
})
const publicEndpointRuntime = publicEndpoint === undefined
  ? new GatewayPublicEndpointService({
      lan: config.lan,
      lanHost: config.gatewayLanHost,
      tailnet: config.tailnet,
      logger,
    })
  : publicEndpoint

let realtimeGateway
const webRtcIngress = registerGatewayHttpRoutes(app, {
  config,
  logger,
  agent,
  gatewayAccessRuntime,
  publicEndpointRuntime,
  inputArbitration,
  realtimeProvider,
  realtimeProviderRegistry,
  frontendMemoryRuntime,
  frontendKnowledgeRuntime,
  retrievalRuntime,
  frontendMcpRuntime,
  frontendOpenApiRuntime,
  notesStore,
  taskStore,
  taskManager,
  runtimeCommands,
  sessionJournalRuntime,
  optionalModules,
  webrtc,
  getGateway: () => realtimeGateway,
})

function localGatewayOrigin(address) {
  const configuredHost = String(config.host || '').trim().toLowerCase()
  const host = ['localhost', '127.0.0.1', '::1'].includes(configuredHost)
    ? configuredHost
    : '127.0.0.1'
  return new URL(`http://${host}:${address.port}`).origin
}

const server = createServer(app)
// Receipt-based tool acceptance reads backend availability from this cache
// instead of probing per spawn_thinking call; the snapshot answers
// synchronously and refreshes itself in the background.
const backendAvailability = new BackendAvailability({
  probe: async () => {
    if (!agent.enabled) return { configured: false, ok: false }
    const health = await agent.health()
    return {
      configured: true,
      ok: health.ok === true,
      // A managed service and its adapter transport come online in stages. Preserve
      // that distinction so receipt-based work is not rejected from a stale
      // cold-start probe, and keep advancing initialization in the background.
      transient: health.status === 'starting'
        || ['NOT_STARTED', 'STARTING', 'BACKEND_STARTING'].includes(health.code),
    }
  },
})
backendAvailability.refresh()
const frontendRuntime = createFrontendRuntime({
  memoryService: frontendMemoryRuntime,
  sessionDigests,
  sessionObservers: [
    ...optionalModules.flatMap(module => module.sessionObservers || []),
    ...(sessionSummariser ? [{
      onSessionClosed: ({ ownerId, sessionId }) => sessionSummariser.maybeRun({ ownerId, sessionId }),
    }] : []),
  ],
  notesStore,
  taskOperations,
  backendRuntime: workBackend,
  backendAvailability,
  respondAuthorization,
  respondInput: (taskId, id, response, options) => (
    agent.respondInput(taskId, id, response, options)
  ),
  permissionPolicy,
  inputAssets: inputAssetRegistry,
  realtimeProviderRegistry,
  defaultRealtimeProvider: realtimeProvider,
  frontendRetrieval: retrievalRuntime,
  frontendKnowledge: frontendKnowledgeRuntime,
  frontendToolSources,
  spawnThinkingDescription,
  taskAnnouncementFactory,
  taskManager,
  conversationSync,
  config,
  logger,
})
realtimeGateway = attachGatewayClientTransport(server, {
  identityManager: gatewayAccessRuntime,
  frontendRuntime,
  inputArbitration,
  clientActionNames,
  clientCommandRuntime: runtimeCommands,
  clientEventRouter: gatewayEventRouter,
  logger,
})
const start = ({ host = config.host, port = config.port } = {}) => {
  if (server.listening) return server
  server.listen(port, host, () => {
    const address = server.address()
    const boundPort = address && typeof address === 'object' ? address.port : port
    const origin = `http://${host}:${boundPort}`
    const readyReport = {
      type: 'qwen-audio-agent:gateway-ready',
      origin,
      instanceId: process.env.QWEN_AUDIO_GATEWAY_INSTANCE_ID || null,
    }
    if (parentPort) {
      // Electron utilityProcess.
      parentPort.postMessage(readyReport)
    } else if (process.send) {
      // Plain Node child_process.fork — how a non-Electron host embeds us.
      process.send(readyReport)
    }
    logger.info('gateway.ready', {
      origin,
      backend: agent.describe?.()?.protocol || config.agentProtocol || 'none',
      realtimeProvider,
    }, `qwen-audio-agent running at ${origin}`)
    void publicEndpointRuntime?.start?.(localGatewayOrigin(address))
  })
  return server
}

let closePromise = null
const close = () => {
  if (closePromise) return closePromise
  closePromise = Promise.resolve().then(async () => {
    backendAvailability.close()
    unsubscribeOfflineNotifications?.()
    reminderScheduler?.close()
    permissionPolicy.close()
    // A Gateway that stops serving cannot honour a resume, so held state must
    // not survive into the next run.
    inputArbitration.close()
    await webRtcIngress?.close()
    await realtimeGateway?.close?.()
    await frontendRuntime.close()
    await frontendMcpRuntime?.close?.()
    await frontendOpenApiRuntime?.close?.()
    for (const source of additionalToolSources) await source.close()
    for (const module of [...optionalModules].reverse()) await module.close?.()
    await publicEndpointRuntime?.close?.()
    unsubscribeSessionTaskJournal?.()
    conversationHistoryRuntime.close?.()
    await sessionJournalRuntime.flush()
    await taskStore?.flush?.()
    if (!server.listening) return
    await new Promise((resolveClose, rejectClose) => {
      server.close(error => {
        if (error) rejectClose(error)
        else resolveClose()
      })
    })
  })
  return closePromise
}

if (autoStart) start()

return {
  app,
  server,
  start,
  close,
  services: {
    agent,
    backendAvailability,
    conversationSync,
    conversationHistory: conversationHistoryRuntime,
    backendRuntime: workBackend,
    ...optionalServices,
    frontendRetrieval: retrievalRuntime,
    frontendMcp: frontendMcpRuntime,
    frontendOpenApi: frontendOpenApiRuntime,
    runtimeCommands,
    gatewayEventRouter,
    publicEndpoint: publicEndpointRuntime,
    identityManager,
    inputArbitration,
    inputAssets: inputAssetRegistry,
    notesStore,
    permissionPolicy,
    realtimeGateway,
    frontendRuntime,
    webRtcIngress,
    sessionDigests,
    sessionSummariser,
    taskManager,
    taskStore,
    sessionJournal: sessionJournalRuntime,
  },
}
}
