import express from 'express'
import { createServer } from 'http'
import { randomUUID } from 'node:crypto'
import { resolve } from 'path'
import { agent as defaultAgent } from '../agent/agent-client.mjs'
import { BackendAvailability } from '../agent/backend-availability.mjs'
import { coordinator as defaultCoordinator } from '../agent/coordinator.mjs'
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
} from '../task/task-manager.mjs'
import { ReminderScheduler } from '../task/reminder-scheduler.mjs'
import { webDistributionPath } from '../core/install-paths.mjs'
import { installOfflineNotifications } from './offline-notifications.mjs'

export function createGatewayApplication({
  config = defaultConfig,
  agent = defaultAgent,
  coordinator = defaultCoordinator,
  conversationSync = defaultConversationSync,
  inputAssets = null,
  taskManager = defaultTaskManager,
  taskStore = defaultTaskStore,
  logger = defaultLogger,
  parentPort = process.parentPort,
  autoStart = true,
  realtimeProviderRegistry = defaultRealtimeProviderRegistry,
  realtimeProvider = config.audioProvider,
} = {}) {
const inputAssetRegistry = inputAssets || new InputAssetRegistry({
  sessionTtlMs: config.conversationSessionTtlMs,
  maxSessions: config.maxConversationSessions,
})
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
taskManager.recoverDelegated({
  canRecover: task => agent.canRecoverDelegatedWork(task),
  runner: (task, context) => agent.recoverDelegatedWork(task, context),
  canceler: async (task, { abort }) => {
    const result = await agent.cancelWork(task.id, {
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
const frontendMemoryService = new FrontendMemoryService({
  userStore: userDocuments,
  memoryStore: memoryDocuments,
})
// Restored scheduled tasks use persisted identity and resolve current memory
// at execution time, exactly like tasks created by a live voice session.
taskManager.configureScheduledTaskRunner(
  async (objective, context) => coordinator.run({
    originalRequest: objective,
    objective,
    conversationContext: [],
    userMemories: frontendMemoryService.list(
      context.ownerId,
      { limit: 64 },
    ),
  }, {
    ownerId: context.ownerId,
    sessionId: context.sessionId,
    turnId: context.turnId,
    coordinationRunId: context.taskId,
    coordinationRequestId: context.jobId,
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
  memoryService: frontendMemoryService,
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
    frontendMemory: frontendMemoryService.health(),
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

app.get('/api/timeline', (req, res) => {
  const items = taskManager.list({
    ownerId: req.identity.ownerId,
    sessionId: req.query.sessionId,
  })
    .filter(task => task.resultMetadata?.presentation?.inline?.content)
    .map(task => ({
      id: `inline_${task.id}`,
      taskId: task.id,
      turnId: task.turnId || null,
      createdAt: task.completedAt || task.createdAt,
      ...task.resultMetadata.presentation.inline,
    }))
    .sort((left, right) => left.createdAt - right.createdAt)
  res.json({ items })
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
  const previousPermissionMode = permissionTask
    ? permissionPolicy.mode(req.identity.ownerId, permissionTask.sessionId)
    : null
  if (permissionTask) {
    permissionPolicy.applyDecision(
      req.identity.ownerId,
      permissionTask.sessionId,
      decision,
    )
  }
  try {
    const permission = await agent.respondPermission(
      req.params.id,
      decision,
      { ownerId: req.identity.ownerId },
    )
    return res.json(permission)
  } catch (error) {
    if (permissionTask && previousPermissionMode) {
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
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  const write = event => res.write(`data: ${JSON.stringify(event)}\n\n`)
  write({ type: 'task.snapshot', task })
  const unsubscribe = taskManager.subscribe(event => {
    if (event.ownerId === req.identity.ownerId && event.task.id === req.params.id) {
      write({ type: event.type, task: event.task })
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
      // A managed service and its ACP bridge come online in stages. Preserve
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
  memoryService: frontendMemoryService,
  memoryExtractor,
  notesStore,
  coordinator,
  backendAvailability,
  respondPermission: (id, decision, options) => (
    agent.respondPermission(id, decision, options)
  ),
  permissionPolicy,
  inputAssets: inputAssetRegistry,
  inputArbitration,
  realtimeProviderRegistry,
  defaultRealtimeProvider: realtimeProvider,
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
    coordinator,
    frontendMemoryService,
    identityManager,
    inputArbitration,
    inputAssets: inputAssetRegistry,
    notesStore,
    permissionPolicy,
    realtimeGateway,
    taskManager,
    taskStore,
  },
}
}
