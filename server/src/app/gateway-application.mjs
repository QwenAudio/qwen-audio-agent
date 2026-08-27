import express from 'express'
import { createServer } from 'http'
import { randomUUID } from 'node:crypto'
import { resolve } from 'path'
import { agent as defaultAgent } from '../agent/agent-client.mjs'
import { BackendAvailability } from '../agent/backend-availability.mjs'
import { BackendWorkRuntime } from '../backend/backend-work-runtime.mjs'
import { config as defaultConfig } from '../core/config.mjs'
import { logger as defaultLogger, runWithLogContext } from '../core/logger.mjs'
import { conversationSync as defaultConversationSync } from '../conversation/conversation-sync.mjs'
import { InputAssetRegistry } from '../voice/input-asset-registry.mjs'
import { IdentityManager } from '../core/identity.mjs'
import { FrontendNotesStore } from '../conversation/frontend-notes.mjs'
import { MemoryAudit } from '../conversation/memory-audit.mjs'
import {
  MemoryExtractor,
  createExtractorLlmCall,
} from '../conversation/memory-extractor.mjs'
import { FrontendMemoryService } from '../conversation/frontend-memory-service.mjs'
import { MarkdownContextStore } from '../conversation/markdown-context-store.mjs'
import { FrontendMemoryRuntime } from '../conversation/memory-runtime.mjs'
import { SessionConversationHistory } from './session-conversation-history.mjs'
import { enforceSameOrigin } from '../core/request-security.mjs'
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
import { SessionPermissionPolicy } from '../voice/session-permission-policy.mjs'
import {
  taskManager as defaultTaskManager,
  taskStore as defaultTaskStore,
  taskSessionJournal as defaultTaskSessionJournal,
} from '../task/task-manager.mjs'
import { ReminderScheduler } from '../task/reminder-scheduler.mjs'
import { webDistributionPath } from '../core/install-paths.mjs'
import { installOfflineNotifications } from './offline-notifications.mjs'
import {
  FrontendRetrievalRuntime,
} from '../frontend/retrieval/frontend-retrieval-runtime.mjs'
import { createWebSearchProvider } from '../providers/search/factory.mjs'
import { FrontendKnowledgeRuntime } from '../frontend/knowledge/knowledge-runtime.mjs'
import { assertFrontendToolSource } from '../frontend/tools/frontend-tool-source.mjs'
import { FrontendMcpClient } from '../providers/mcp/frontend-mcp-client.mjs'
import {
  loadFrontendMcpConfiguration,
} from '../providers/mcp/frontend-mcp-config.mjs'
import {
  FrontendOpenApiAdapter,
} from '../providers/openapi/frontend-openapi-adapter.mjs'
import {
  loadFrontendOpenApiConfiguration,
} from '../providers/openapi/frontend-openapi-config.mjs'
import {
  projectGatewayTaskEvent,
  projectGatewayTaskSnapshot,
} from '../transport/gateway-task-event-projector.mjs'
import {
  projectGatewayTaskEventForFormat,
} from '../transport/agui-event-projector.mjs'
import { replaySession } from '../session/session-replay.mjs'

export function createGatewayApplication({
  config = defaultConfig,
  agent = defaultAgent,
  backendRuntime = null,
  conversationSync = defaultConversationSync,
  inputAssets = null,
  taskManager = defaultTaskManager,
  taskStore = defaultTaskStore,
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
  frontendMcp = undefined,
  frontendOpenApi = undefined,
  sessionJournal = null,
  conversationHistory = null,
  taskAnnouncementFactory = undefined,
} = {}) {
const workBackend = backendRuntime || new BackendWorkRuntime({ backend: agent })
const sessionJournalRuntime = sessionJournal || defaultTaskSessionJournal
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
const knowledgeProviderRuntime = knowledgeProvider || knowledgeRetrievalProvider
const frontendKnowledgeRuntime = frontendKnowledge || (knowledgeProviderRuntime
  ? new FrontendKnowledgeRuntime({ provider: knowledgeProviderRuntime })
  : null)
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
// The built-in Markdown provider preserves the existing USER.md/MEMORY.md
// behaviour. Embedders can replace the entire persistence boundary without
// changing Realtime, extraction, or tool handling code.
let defaultMemoryProvider = null
if (memoryProvider === undefined && !frontendMemory) {
  const userDocuments = new MarkdownContextStore({
    filePath: config.userModelPath,
    scope: 'user',
    personalOwnerId: config.personalOwnerId,
    maxChars: 6000,
    template: '# USER',
    onWarning: warning => logger.warn('user_model.persistence_warning', { warning }),
  })
  const memoryDocuments = new MarkdownContextStore({
    filePath: config.frontendMemoryPath,
    scope: 'memory',
    personalOwnerId: config.personalOwnerId,
    maxChars: 8000,
    template: '# MEMORY',
    onWarning: warning => logger.warn('memory.persistence_warning', { warning }),
  })
  defaultMemoryProvider = new FrontendMemoryService({
    userStore: userDocuments,
    memoryStore: memoryDocuments,
  })
}
const memoryProviderRuntime = memoryProvider === undefined
  ? defaultMemoryProvider
  : memoryProvider
const frontendMemoryRuntime = frontendMemory || (memoryProviderRuntime
  ? new FrontendMemoryRuntime({ provider: memoryProviderRuntime })
  : null)
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
    onEvent: context.onEvent,
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
// Invisible memory (issue #92): after a voice session closes, a lightweight
// text model reconciles explicit user directives and durable facts through the
// same context service used by the realtime memory tool.
// Without an API key createExtractorLlmCall returns null
// and the extractor stays silently disabled; explicit memories are
// unaffected. ASSISTANT.md is never exposed as a writable document.
const memoryExtractor = new MemoryExtractor({
  memoryService: frontendMemoryRuntime,
  conversationSync,
  audit: new MemoryAudit({
    filePath: config.memoryAuditPath,
    onWarning: warning => logger.warn('memory.audit_warning', { warning }),
  }),
  llmCall: config.memoryAutoEnabled
    ? createExtractorLlmCall({
        baseUrl: config.memoryBaseUrl,
        apiKey: config.memoryApiKey,
        model: config.memoryModel,
      })
    : null,
  logger,
})
const app = express()
const permissionPolicy = new SessionPermissionPolicy({
  ttlMs: config.conversationSessionTtlMs,
  maxSessions: config.maxConversationSessions,
})

app.disable('x-powered-by')
app.use(enforceSameOrigin)
app.use((req, res, next) => {
  req.identity = identityManager.resolveHttp(req, res)
  const requestId = randomUUID()
  res.setHeader('X-Request-Id', requestId)
  runWithLogContext({
    requestId,
    ownerId: req.identity?.ownerId,
  }, next)
})
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
app.use(express.json({ limit: '1mb' }))

let realtimeGateway

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
    tasks: taskManager.list({
      ownerId: req.identity.ownerId,
      sessionId: req.query.sessionId,
      active: req.query.active === 'true',
    }),
  })
})

// Durable session facts are intentionally exposed separately from UI state.
// Clients may use this for reconnect/recovery; projections should not need to
// understand the on-disk JSONL format.
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
    const messages = await conversationHistoryRuntime.messages({
      ownerId: req.identity.ownerId,
      sessionId: req.params.sessionId,
    })
    res.json({ messages })
  } catch (error) {
    next(error)
  }
})

app.get('/api/tasks/:id', (req, res) => {
  const task = taskManager.get(req.params.id, { ownerId: req.identity.ownerId })
  if (!task) return res.status(404).json({ error: 'task not found' })
  res.json(task)
})

app.delete('/api/tasks/:id', async (req, res) => {
  const existing = taskManager.get(req.params.id, {
    ownerId: req.identity.ownerId,
  })
  if (!existing) return res.status(404).json({ error: 'task not found' })
  const task = await taskManager.cancel(req.params.id, {
    ownerId: req.identity.ownerId,
  })
  if (!task) {
    return res.status(409).json({
      error: 'task is no longer active',
      task: existing,
    })
  }
  res.json(task)
})

app.post('/api/permissions/:id', async (req, res, next) => {
  const decision = String(req.body?.decision || '')
  if (!['always', 'reject'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be always or reject' })
  }
  const permissionTask = taskManager.list({
    ownerId: req.identity.ownerId,
    active: true,
  }).find(task => task.authorization?.id === req.params.id)
  if (!permissionTask) {
    return res.status(404).json({ error: 'permission request not found' })
  }
  const previousPermissionMode = permissionPolicy.mode(
    req.identity.ownerId,
    permissionTask.sessionId,
  )
  permissionPolicy.applyDecision(
    req.identity.ownerId,
    permissionTask.sessionId,
    decision,
  )
  try {
    const permission = await agent.respondAuthorization(
      permissionTask.id,
      req.params.id,
      decision,
      { ownerId: req.identity.ownerId },
    )
    return res.json(permission)
  } catch (error) {
    if (previousPermissionMode) {
      permissionPolicy.setMode(
        req.identity.ownerId,
        permissionTask.sessionId,
        previousPermissionMode,
      )
    }
    if (error?.status === 404) {
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

const webDist = webDistributionPath()
// Imported orb skins live under the config directory. The orb page fetches
// `skins/<id>/...` relative to its own origin, so serving them here means a
// host that points a window at the Gateway needs no separate asset server.
// Static assets only, no fallback to index.html for missing files.
app.use('/skins', express.static(resolve(config.configDirectory, 'skins'), {
  index: false,
  redirect: false,
  dotfiles: 'ignore',
  // Imports and removals must be visible on the next orb reload.
  setHeaders: response => response.setHeader('cache-control', 'no-store'),
}), (req, res) => res.status(404).json({ error: 'not found' }))
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
  identityManager,
  memoryService: frontendMemoryRuntime,
  memoryExtractor,
  notesStore,
  backendRuntime: workBackend,
  backendAvailability,
  respondAuthorization: (taskId, id, decision, options) => (
    agent.respondAuthorization(taskId, id, decision, options)
  ),
  permissionPolicy,
  inputAssets: inputAssetRegistry,
  inputArbitration,
  realtimeProviderRegistry,
  defaultRealtimeProvider: realtimeProvider,
  frontendRetrieval: retrievalRuntime,
  frontendKnowledge: frontendKnowledgeRuntime,
  frontendToolSources,
  taskAnnouncementFactory,
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
      backend: config.agentProtocol || 'none',
      realtimeProvider,
    }, `qwen-audio-agent running at ${origin}`)
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
    // A Gateway that stops serving cannot honour a resume, so held state must
    // not survive into the next run.
    inputArbitration.close()
    await realtimeGateway?.close?.()
    await frontendMcpRuntime?.close?.()
    await frontendOpenApiRuntime?.close?.()
    await frontendKnowledgeRuntime?.close?.()
    await frontendMemoryRuntime?.close?.()
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
    // Preserve the original service handle for embedders using the built-in
    // synchronous Markdown API. New integrations should use frontendMemory.
    frontendMemoryService: memoryProviderRuntime,
    frontendMemory: frontendMemoryRuntime,
    memoryProvider: memoryProviderRuntime,
    frontendRetrieval: retrievalRuntime,
    frontendKnowledge: frontendKnowledgeRuntime,
    frontendMcp: frontendMcpRuntime,
    frontendOpenApi: frontendOpenApiRuntime,
    knowledgeProvider: knowledgeProviderRuntime,
    identityManager,
    inputArbitration,
    inputAssets: inputAssetRegistry,
    notesStore,
    permissionPolicy,
    realtimeGateway,
    taskManager,
    taskStore,
    sessionJournal: sessionJournalRuntime,
  },
}
}
