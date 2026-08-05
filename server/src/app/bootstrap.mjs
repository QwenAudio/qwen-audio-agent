import express from 'express'
import { createServer } from 'http'
import { randomUUID } from 'node:crypto'
import { resolve } from 'path'
import { agent } from '../agent/agent-client.mjs'
import { coordinator } from '../agent/coordinator.mjs'
import { config } from '../core/config.mjs'
import { logger, runWithLogContext } from '../core/logger.mjs'
import { conversationSync } from '../conversation/conversation-sync.mjs'
import { IdentityManager } from '../core/identity.mjs'
import { FrontendMemoryStore } from '../conversation/frontend-memory.mjs'
import { FrontendNotesStore } from '../conversation/frontend-notes.mjs'
import { ProfiledMemoryStore } from '../conversation/profiled-memory-store.mjs'
import { UserProfile } from '../conversation/user-profile.mjs'
import { enforceSameOrigin } from '../core/request-security.mjs'
import { attachRealtimeGateway } from '../voice/realtime-gateway.mjs'
import { describeActiveRealtime } from '../voice/realtime-provider.mjs'
import { SessionPermissionPolicy } from '../voice/session-permission-policy.mjs'
import { taskManager, taskStore } from '../task/task-manager.mjs'
import { ReminderScheduler } from '../task/reminder-scheduler.mjs'
import { webDistributionPath } from '../core/install-paths.mjs'

const identityManager = new IdentityManager({
  secret: config.authSecret,
  mode: config.identityMode,
  personalOwnerId: config.personalOwnerId,
})
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
    const result = await agent.cancelDelegatedWork(task.id, {
      ownerId: task.ownerId,
    })
    abort()
    return result
  },
})
// Provide a fallback runner for restored scheduled_task entries whose
// runner (a closure) was lost during serialisation. Uses the shared
// coordinator singleton — same path as handleScheduleReminder.
taskManager.configureScheduledTaskRunner(
  async (objective, { onEvent, signal }) => coordinator.run({
    originalRequest: objective,
    objective,
    conversationContext: [],
    userMemories: [],
  }, { signal, onEvent }),
)
taskManager.configureCoordinatorQuery(
  (workId, question, options) => coordinator.queryDelegatedWork(workId, question, options),
)
// ReminderScheduler: setTimeout-driven, no polling. Handles overdue
// stagger on restart and re-arming after each fire.
if (config.reminderSchedulerEnabled) {
  const reminderScheduler = new ReminderScheduler({
    taskManager,
    staggerMs: config.reminderStaggerMs,
    logger,
  })
  reminderScheduler.start()
}
// Offline notification subscriber: if a voice session does not claim a
// pending notification within the delay window, deliver via desktop
// notification (Electron) and WebSocket push.
taskManager.subscribe(event => {
  if (event.type === 'task.progress.check') {
    const timer = setTimeout(() => {
      if (process.parentPort) {
        process.parentPort.postMessage({
          type: 'qwen-audio-agent:offline-notification',
          task: {
            id: event.task.id,
            objective: event.task.objective,
            result: event.message,
            status: 'progress',
          },
        })
      }
    }, config.offlineNotificationDelayMs)
    timer.unref?.()
    return
  }
  if (event.type !== 'task.notification.pending') return
  const task = event.task
  const timer = setTimeout(() => {
    const current = taskManager.get(task.id, { ownerId: event.ownerId })
    if (current && current.notificationStatus === 'pending') {
      if (process.parentPort) {
        process.parentPort.postMessage({
          type: 'qwen-audio-agent:offline-notification',
          task: {
            id: current.id,
            objective: current.objective,
            result: current.result,
            error: current.error,
            status: current.status,
          },
        })
      }
    }
  }, config.offlineNotificationDelayMs)
  timer.unref?.()
})
conversationSync.configureRetention({
  sessionTtlMs: config.conversationSessionTtlMs,
  maxSessions: config.maxConversationSessions,
})
const dynamicMemory = new FrontendMemoryStore({
  filePath: config.frontendMemoryPath,
  maxOwners: config.maxFrontendMemoryOwners,
  ownerTtlMs: config.frontendMemoryOwnerTtlMs,
  onWarning: warning => logger.warn('memory.persistence_warning', { warning }),
})
const frontendMemory = new ProfiledMemoryStore({
  memoryStore: dynamicMemory,
  userProfile: config.identityMode === 'personal'
    ? new UserProfile({
        filePath: config.userProfilePath,
        onWarning: warning => logger.warn('profile.persistence_warning', {
          warning,
        }),
      })
    : null,
})
const notesStore = new FrontendNotesStore({
  filePath: config.frontendNotesPath,
  maxOwners: config.maxFrontendMemoryOwners,
  ownerTtlMs: config.frontendMemoryOwnerTtlMs,
  onWarning: warning => logger.warn('notes.persistence_warning', { warning }),
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
    if (res.statusCode >= 500) logger.warn('http.request_failed', fields)
    else logger.debug('http.request_completed', fields)
  })
  next()
})
app.use(express.json({ limit: '1mb' }))

let realtimeGateway

app.get('/api/health', async (req, res) => {
  const backend = await agent.health()
  const backendDescription = agent.describe()
  const realtime = describeActiveRealtime()
  res.status(backend.ok ? 200 : 503).json({
    ok: backend.ok,
    gatewayInstanceId: process.env.QWEN_AUDIO_GATEWAY_INSTANCE_ID || null,
    gatewayStartedAt: process.env.QWEN_AUDIO_GATEWAY_STARTED_AT || null,
    voiceConfigured: realtime.configured,
    realtimeProvider: realtime.provider,
    realtimeLabel: realtime.label,
    realtimeModel: realtime.model,
    realtimeInputSampleRate: realtime.inputSampleRate,
    realtimeConfigurationSignature: realtime.configurationSignature,
    // Front ends a client may select for its session through the realtime
    // connect event.
    realtimeProviders: realtime.providers,
    announceIntoContext: config.announceIntoContext,
    resultContextMaxChars: config.resultContextMaxChars,
    announcementBatchMs: config.announcementBatchMs,
    announcementQuietMs: config.announcementQuietMs,
    frontendMemory: frontendMemory.health(),
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
export { server }
realtimeGateway = attachRealtimeGateway(server, {
  identityManager,
  memoryStore: frontendMemory,
  notesStore,
  coordinator,
  coordinatorAvailable: async () => ({
    enabled: agent.enabled,
    ok: agent.enabled && (await agent.health()).ok === true,
  }),
  respondPermission: (id, decision, options) => (
    agent.respondPermission(id, decision, options)
  ),
  permissionPolicy,
})
server.listen(config.port, config.host, () => {
  const address = server.address()
  const port = address && typeof address === 'object' ? address.port : config.port
  const origin = `http://${config.host}:${port}`
  if (process.parentPort) {
    process.parentPort.postMessage({
      type: 'qwen-audio-agent:gateway-ready',
      origin,
      instanceId: process.env.QWEN_AUDIO_GATEWAY_INSTANCE_ID || null,
    })
  }
  logger.info('gateway.ready', {
    origin,
    backend: config.agentProtocol || 'none',
    realtimeProvider: config.audioProvider,
  }, `qwen-audio-agent running at ${origin}`)
})
