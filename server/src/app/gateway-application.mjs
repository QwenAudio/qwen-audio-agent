import { optionalModuleFactories } from './optional-modules.mjs'
import { OperationAudit } from '../core/operation-audit.mjs'
import express from 'express'
import { PERMISSION_DECISIONS } from '../core/work-authorization.mjs'
import { createServer } from 'http'
import { randomUUID } from 'node:crypto'
import { resolve } from 'path'
import { agent as defaultAgent } from '../backend/adapters/agent-client.mjs'
import { BackendAvailability } from '../backend/availability.mjs'
import { BackendWorkRuntime } from '../backend/backend-work-runtime.mjs'
import { config as defaultConfig } from '../core/config.mjs'
import { logger as defaultLogger, runWithLogContext } from '../core/logger.mjs'
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
import { enforceSameOrigin, isAllowedOrigin } from '../core/request-security.mjs'
import {
  GatewayAccessManager,
  GatewayDeviceRegistry,
  parseGatewayAccessKeys,
} from '../access/gateway-access.mjs'
import { gatewayBrowserPairingPage } from '../access/browser-pairing-page.mjs'
import { GatewayPublicEndpointService } from '../access/gateway-public-endpoint.mjs'
import {
  GATEWAY_CAPABILITIES,
  GATEWAY_PROTOCOL_VERSION,
} from '../core/gateway-protocol.mjs'
import { attachRealtimeGateway } from '../voice/realtime-gateway.mjs'
import {
  defaultRealtimeProviderRegistry,
  describeActiveRealtime,
} from '../voice/realtime-provider.mjs'
import { InputArbitration } from '../voice/input-arbitration.mjs'
import { PermissionPolicy } from '../task/permission-policy.mjs'
import { TaskManager } from '../task/task-manager.mjs'
import { TaskStore } from '../task/task-store.mjs'
import { SessionJournalRegistry } from '../session/session-journal-registry.mjs'
import { ReminderScheduler } from '../task/reminder-scheduler.mjs'
import { webDistributionPath } from '../core/install-paths.mjs'
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
import {
  projectGatewayTaskEvent,
  projectGatewayTaskSnapshot,
} from '../transport/gateway-task-event-projector.mjs'
import {
  projectGatewayTaskEventForFormat,
} from '../transport/agui-event-projector.mjs'
import {
  gatewayDeviceConnectionResponse,
  parseGatewayConnectionEndpoint,
} from '../access/device-connection.mjs'
import { replaySession } from '../session/session-replay.mjs'
import { GatewayClientCommandRuntime } from '../client/client-command-runtime.mjs'
import {
  BUILTIN_CLIENT_EVENT_DEFINITIONS,
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
  sessionJournal = null,
  conversationHistory = null,
  taskAnnouncementFactory = undefined,
  clientCommandRuntime = null,
  clientEventRouter = null,
  clientEventDefinitions = [],
  spawnThinkingDescription = '',
  gatewayAccess = null,
  publicEndpoint = undefined,
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
  async (objective, context) => workBackend.run({
    objective,
  }, {
    ownerId: context.ownerId,
    sessionId: context.sessionId,
    turnId: context.turnId,
    taskId: context.taskId,
    signal: context.signal,
    onEvent: event => permissionPolicy.forwardBackendEvent(
      context, event, context.onEvent, respondAuthorization,
    ),
  }),
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
  backendRuntime: workBackend,
  conversationHistory: conversationHistoryRuntime,
  respondAuthorization,
  respondInput: (taskId, id, response, options) => (
    agent.respondInput(taskId, id, response, options)
  ),
  permissionPolicy,
  logger,
})
const gatewayEventRouter = clientEventRouter || new GatewayEventRouter({
  registry: new ClientEventDefinitionRegistry({
    definitions: [
      ...BUILTIN_CLIENT_EVENT_DEFINITIONS,
      ...clientEventDefinitions,
    ],
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

app.disable('x-powered-by')
app.use(express.json({ limit: '1mb' }))

// This shell contains no Gateway data. It is the only application page that
// can load before authentication; the pairing code remains in the URL fragment
// and is therefore never sent in an HTTP request or access log.
app.get('/c', (_req, res) => {
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'")
  res.setHeader('referrer-policy', 'no-referrer')
  return res.type('html').send(gatewayBrowserPairingPage())
})

// Legacy pairing authenticates with a short-lived, one-time ticket created by
// a local Client. Native clients may omit Origin; browser Origins are checked
// before the ticket is redeemed.
app.post('/api/access/pair', (req, res) => {
  if (req.headers.origin !== undefined && !isAllowedOrigin(req, {
    allowedOrigins: config.allowedOrigins,
    allowSecureSameOrigin: true,
  })) {
    return res.status(403).json({ error: 'origin not allowed' })
  }
  const paired = gatewayAccessRuntime.redeemPairingTicket(req.body?.code, {
    device: req.body?.device,
  })
  if (!paired) {
    return res.status(401).json({
      error: 'pairing ticket is invalid or expired',
      code: 'pairing_invalid',
    })
  }
  const identity = {
    ownerId: paired.device.ownerId,
    access: 'remote',
    credentialId: paired.credentialId,
  }
  gatewayAccessRuntime.issueCookie(res, identity, req)
  return res.json({
    access_token: paired.token,
    owner_id: paired.device.ownerId,
    device: paired.device,
  })
})

// A direct connection QR opens the browser shell with the credential in the
// fragment. Exchange it once for an HttpOnly cookie so the token never enters
// browser storage, application URLs, or subsequent WebSocket messages.
app.post('/api/access/session', (req, res) => {
  if (!isAllowedOrigin(req, {
    allowedOrigins: config.allowedOrigins,
    allowSecureSameOrigin: true,
    allowLanSameOrigin: true,
  })) {
    return res.status(403).json({ error: 'origin not allowed' })
  }
  const token = String(req.body?.token || '').trim()
  const credential = token ? gatewayAccessRuntime.findCredential(token) : null
  if (!credential) {
    return res.status(401).json({
      error: 'device credential is invalid or revoked',
      code: 'device_credential_invalid',
    })
  }
  const identity = {
    ownerId: credential.ownerId,
    access: 'remote',
    credentialId: credential.tokenId || credential.id,
    clientType: credential.type || '',
  }
  gatewayAccessRuntime.issueCookie(res, identity, req)
  res.setHeader('cache-control', 'no-store')
  return res.status(204).end()
})

app.use((req, res, next) => {
  req.identity = gatewayAccessRuntime.resolveHttp(req, res)
  if (!req.identity) {
    return res.status(401).json({
      error: 'Gateway access authentication required',
      code: 'access_required',
    })
  }
  const requestId = randomUUID()
  res.setHeader('X-Request-Id', requestId)
  runWithLogContext({
    requestId,
    ownerId: req.identity?.ownerId,
  }, next)
})
app.use(enforceSameOrigin)
app.use((req, res, next) => {
  const startedAt = Date.now()
  res.once('finish', () => {
    const fields = {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
    }
    if (res.statusCode >= 500) {
      logger.warn('http.request_failed', fields)
    } else {
      logger.debug('http.request_completed', fields)
    }
  })
  next()
})
let realtimeGateway

app.post('/api/access/pairing-tickets', (req, res) => {
  if (req.identity.access !== 'local') {
    return res.status(403).json({ error: 'pairing tickets can only be created locally' })
  }
  const endpoint = publicEndpointRuntime?.status?.().endpoint?.url
  if (!endpoint) {
    return res.status(409).json({
      error: '旧版配对需要使用 --lan 或 --tailnet 启动 Gateway',
      code: 'gateway_public_url_required',
    })
  }
  return res.status(201).json({
    ...gatewayAccessRuntime.createPairingTicket({
      ownerId: req.identity.ownerId,
    }),
    gatewayUrl: endpoint,
  })
})

app.get('/api/access/devices', (req, res) => {
  if (req.identity.access !== 'local') {
    return res.status(403).json({ error: 'paired devices can only be managed locally' })
  }
  return res.json({ devices: gatewayAccessRuntime.deviceRegistry.list() })
})

app.post('/api/access/devices', (req, res) => {
  if (req.identity.access !== 'local') {
    return res.status(403).json({ error: 'device credentials can only be issued locally' })
  }
  let endpoint
  try {
    endpoint = req.body?.endpoint
      ? parseGatewayConnectionEndpoint(req.body.endpoint)
      : publicEndpointRuntime?.status?.().endpoint?.url
  } catch (error) {
    return res.status(400).json({
      error: error.message,
      code: error.code || 'gateway_connection_endpoint_invalid',
    })
  }
  if (!endpoint) {
    return res.status(409).json({
      error: 'Gateway 没有可供客户端访问的 Endpoint；请使用 --lan、--tailnet，或在 pair 时传入 --endpoint',
      code: 'gateway_connection_endpoint_required',
    })
  }
  const issued = gatewayAccessRuntime.issueDeviceCredential({
    ownerId: req.identity.ownerId,
    // Direct issuance always allocates a fresh device identity. A caller may
    // describe the client, but cannot rotate an existing record by reusing ID.
    device: {
      type: req.body?.device?.type,
      label: req.body?.device?.label,
    },
  })
  return res.status(201).json(gatewayDeviceConnectionResponse({ endpoint, issued }))
})

app.delete('/api/access/devices/:id', (req, res) => {
  if (req.identity.access !== 'local') {
    return res.status(403).json({ error: 'paired devices can only be managed locally' })
  }
  const credentialId = gatewayAccessRuntime.deviceRegistry.credentialId(req.params.id)
  if (!gatewayAccessRuntime.deviceRegistry.revoke(req.params.id)) {
    return res.status(404).json({ error: 'paired device not found' })
  }
  realtimeGateway?.disconnectCredential(credentialId)
  return res.status(204).end()
})

function localGatewayOrigin(address) {
  const configuredHost = String(config.host || '').trim().toLowerCase()
  const host = ['localhost', '127.0.0.1', '::1'].includes(configuredHost)
    ? configuredHost
    : '127.0.0.1'
  return new URL(`http://${host}:${address.port}`).origin
}

app.delete('/api/access/session', (req, res) => {
  gatewayAccessRuntime.clearCookie(res, req)
  return res.status(204).end()
})

app.get('/livez', (req, res) => {
  res.json({ ok: true, status: 'live' })
})

app.get('/readyz', (req, res) => {
  res.json({ ok: true, status: 'ready' })
})

app.get('/api/health', (req, res) => {
  const backend = agent.status()
  const backendDescription = agent.describe()
  const realtime = describeActiveRealtime(realtimeProvider, {
    registry: realtimeProviderRegistry,
  })
  res.json({
    // Gateway liveness is independent from optional backend readiness.
    ok: true,
    status: 'ready',
    // Contract surface: clients branch on a capability, not a product version.
    protocolVersion: GATEWAY_PROTOCOL_VERSION,
    capabilities: GATEWAY_CAPABILITIES,
    gatewayInstanceId: process.env.QWEN_AUDIO_GATEWAY_INSTANCE_ID || null,
    gatewayStartedAt: process.env.QWEN_AUDIO_GATEWAY_STARTED_AT || null,
    publicEndpoint: publicEndpointRuntime?.status?.() || {
      mode: 'none',
      state: 'disabled',
      endpoint: null,
      error: null,
    },
    inputSuspension: inputArbitration.status(),
    voiceConfigured: realtime.configured,
    realtimeProvider: realtime.provider,
    realtimeLabel: realtime.label,
    realtimeModel: realtime.model,
    realtimeModelProfile: realtime.modelProfile,
    realtimeModelCatalog: realtime.modelCatalog,
    realtimeInputSampleRate: realtime.inputSampleRate,
    realtimeConfigurationSignature: realtime.configurationSignature,
    // Front ends a client may select for its session through the realtime
    // connect event.
    realtimeProviders: realtime.providers,
    announceIntoContext: config.announceIntoContext,
    resultContextMaxChars: config.resultContextMaxChars,
    announcementBatchMs: config.announcementBatchMs,
    announcementQuietMs: config.announcementQuietMs,
    frontendMemory: frontendMemoryRuntime?.health() || {
      ok: true,
      configured: false,
      provider: null,
    },
    frontendProfile: config.frontendProfile || {
      configured: false,
      name: 'default',
      description: '',
    },
    frontendRetrieval: retrievalRuntime.describe(),
    frontendKnowledge: frontendKnowledgeRuntime?.describe() || {
      configured: false,
      capabilities: [],
      provider: null,
    },
    frontendMcp: frontendMcpRuntime?.health?.() || {
      ok: true,
      initialized: true,
      tools: 0,
      servers: [],
    },
    frontendOpenApi: frontendOpenApiRuntime?.health?.() || {
      ok: true,
      initialized: true,
      tools: 0,
      apis: [],
    },
    notes: notesStore.health(),
    taskStore: taskStore.health(),
    identityMode: config.identityMode,
    gatewayAccess: gatewayAccessRuntime.describe(),
    voiceClients: realtimeGateway?.status() || {
      connected: 0,
      activeOwners: 0,
      byType: {},
    },
    backend: {
      ...backendDescription,
      ...backend,
    },
  })
})

for (const module of optionalModules) module.mountRoutes?.(app)

// Host control plane for microphone arbitration. The host announces that it is
// taking the microphone and the Gateway commands its clients to stop capturing.
// Both calls are idempotent per owner, and a suspension expires on its own so a
// host that crashes cannot silence the Gateway for good.
app.post('/api/input/suspend', (req, res) => {
  try {
    return res.json(inputArbitration.suspend({
      owner: req.body?.owner,
      reason: req.body?.reason,
      ttlMs: req.body?.ttlMs,
    }))
  } catch (error) {
    if (error?.code === 'QWAUDIO_INPUT_OWNER_REQUIRED') {
      return res.status(400).json({ error: error.message, code: error.code })
    }
    throw error
  }
})

app.post('/api/input/resume', (req, res) => {
  res.json(inputArbitration.resume({ owner: req.body?.owner }))
})

app.get('/api/input', (req, res) => {
  res.json(inputArbitration.status())
})

app.get('/api/backend/ui', async (req, res, next) => {
  if (!agent.describe().capabilities.backendUi) {
    return res.status(404).json({ error: '当前后台 Agent 没有独立的 Web 地址' })
  }
  try {
    const url = await agent.uiUrl({ ownerId: req.identity.ownerId })
    if (!url) {
      return res.status(404).json({
        error: '当前后台 Agent 没有独立的 Web 地址',
      })
    }
    return res.redirect(302, url)
  } catch (error) {
    return next(error)
  }
})

app.get('/api/tasks', (req, res) => {
  res.json({
    tasks: runtimeCommands.listTasks({
      session_id: req.query.sessionId,
      active: req.query.active === 'true',
      limit: Number.MAX_SAFE_INTEGER,
    }, { ownerId: req.identity.ownerId, allSessions: true }),
  })
})

app.get('/api/timeline', (req, res) => {
  const items = taskManager.list({
    ownerId: req.identity.ownerId,
    sessionId: req.query.sessionId,
  })
    .filter(task => task.presentation?.inline?.content)
    .map(task => ({
      id: `inline_${task.id}`,
      taskId: task.id,
      createdAt: task.completedAt || task.createdAt,
      ...task.presentation.inline,
    }))
    .sort((left, right) => left.createdAt - right.createdAt)
  res.json({ items })
})

// Durable session facts are intentionally exposed separately from the UI
// timeline. Clients may use this for reconnect/recovery; projections should
// not need to understand the on-disk JSONL format.
app.get('/api/sessions/:sessionId/events', async (req, res, next) => {
  try {
    const events = await sessionJournalRuntime.read(
      req.identity.ownerId,
      req.params.sessionId,
    )
    res.json({ events })
  } catch (error) {
    next(error)
  }
})

app.get('/api/sessions/:sessionId/replay', async (req, res, next) => {
  try {
    const events = await sessionJournalRuntime.read(
      req.identity.ownerId,
      req.params.sessionId,
    )
    res.json({ replay: replaySession(events, { sessionId: req.params.sessionId }) })
  } catch (error) {
    next(error)
  }
})

// Stable, bounded UI projection. Clients never depend on Session Journal
// records or diagnostic logs, and Realtime consumes this same projection.
app.get('/api/conversations/:sessionId/messages', async (req, res, next) => {
  try {
    const messages = await runtimeCommands.history({
      session_id: req.params.sessionId,
    }, { ownerId: req.identity.ownerId })
    res.json({ messages })
  } catch (error) {
    next(error)
  }
})

app.get('/api/tasks/:id', (req, res) => {
  try {
    res.json(runtimeCommands.getTask(req.params.id, {
      ownerId: req.identity.ownerId,
    }))
  } catch (error) {
    if (error?.code === 'task_not_found') {
      return res.status(404).json({ error: 'task not found' })
    }
    res.status(400).json({ error: error.message })
  }
})

app.delete('/api/tasks/:id', async (req, res, next) => {
  try {
    const task = await runtimeCommands.cancelTask(req.params.id, {
      ownerId: req.identity.ownerId,
    }, { wait: true })
    res.json(task)
  } catch (error) {
    if (error?.code === 'task_not_found') {
      return res.status(404).json({ error: 'task not found' })
    }
    if (error?.code === 'task_not_cancellable') {
      return res.status(409).json({
        error: 'task is no longer active',
        task: runtimeCommands.getTask(req.params.id, {
          ownerId: req.identity.ownerId,
        }),
      })
    }
    next(error)
  }
})

app.post('/api/permissions/:id', async (req, res, next) => {
  const decision = String(req.body?.decision || '')
  if (!PERMISSION_DECISIONS.includes(decision)) {
    return res.status(400).json({
      error: 'decision must be task, always, or reject',
    })
  }
  try {
    const permission = await runtimeCommands.respondPermission({
      permission_id: req.params.id,
      decision,
    }, { ownerId: req.identity.ownerId })
    return res.json(permission)
  } catch (error) {
    if (error?.status === 404 || error?.code === 'permission_not_found') {
      return res.status(404).json({ error: error.message })
    }
    return next(error)
  }
})

app.get('/api/tasks/:id/events', (req, res) => {
  const task = taskManager.get(req.params.id, { ownerId: req.identity.ownerId })
  if (!task) return res.status(404).json({ error: 'task not found' })
  const projectEvent = event => projectGatewayTaskEventForFormat(
    event,
    req.query.format,
  )
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  const write = event => res.write(`data: ${JSON.stringify(event)}\n\n`)
  write(projectEvent(projectGatewayTaskSnapshot(task)))
  const unsubscribe = taskManager.subscribe(event => {
    if (event.ownerId === req.identity.ownerId && event.task.id === req.params.id) {
      const publicEvent = projectGatewayTaskEvent(event)
      if (publicEvent) write(projectEvent(publicEvent))
    }
  })
  res.on('close', unsubscribe)
})

// Omitted feature routes stay absent; unknown API paths must not serve the SPA.
app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }))

const webDist = webDistributionPath()
// Desktop serves its own skins. An embedding host may explicitly share a
// client-owned asset directory for read-only web hosting; Gateway never owns
// or discovers skins in its data directories.
if (config.webSkinsDirectory) {
  app.use('/skins', express.static(config.webSkinsDirectory, {
    index: false,
    redirect: false,
    dotfiles: 'ignore',
    setHeaders: response => response.setHeader('cache-control', 'no-store'),
  }))
}
app.use('/skins', (req, res) => res.status(404).json({ error: 'not found' }))
app.use(express.static(webDist))
app.get('*', (req, res) => res.sendFile(resolve(webDist, 'index.html')))
app.use((error, req, res, next) => {
  logger.error('http.unhandled_error', {
    method: req.method,
    path: req.path,
    error,
  })
  next(error)
})

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
realtimeGateway = attachRealtimeGateway(server, {
  identityManager: gatewayAccessRuntime,
  memoryService: frontendMemoryRuntime,
  sessionDigests,
  sessionObservers: [
    ...optionalModules.flatMap(module => module.sessionObservers || []),
    ...(sessionSummariser ? [{
      onSessionClosed: ({ ownerId, sessionId }) => sessionSummariser.maybeRun({ ownerId, sessionId }),
    }] : []),
  ],
  notesStore,
  backendRuntime: workBackend,
  backendAvailability,
  respondAuthorization,
  respondInput: (taskId, id, response, options) => (
    agent.respondInput(taskId, id, response, options)
  ),
  permissionPolicy,
  inputAssets: inputAssetRegistry,
  inputArbitration,
  realtimeProviderRegistry,
  defaultRealtimeProvider: realtimeProvider,
  frontendRetrieval: retrievalRuntime,
  frontendKnowledge: frontendKnowledgeRuntime,
  frontendToolSources,
  spawnThinkingDescription,
  taskAnnouncementFactory,
  clientCommandRuntime: runtimeCommands,
  clientEventRouter: gatewayEventRouter,
  taskManager,
  conversationSync,
  config,
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
    await realtimeGateway?.close?.()
    await frontendMcpRuntime?.close?.()
    await frontendOpenApiRuntime?.close?.()
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
    sessionDigests,
    sessionSummariser,
    taskManager,
    taskStore,
    sessionJournal: sessionJournalRuntime,
  },
}
}
