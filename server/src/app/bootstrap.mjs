import express from 'express'
import { createServer } from 'http'
import { resolve } from 'path'
import { agent } from '../agent/agent-client.mjs'
import { coordinator } from '../agent/coordinator.mjs'
import { config } from '../core/config.mjs'
import { conversationSync } from '../conversation/conversation-sync.mjs'
import { IdentityManager } from '../core/identity.mjs'
import { FrontendMemoryStore } from '../conversation/frontend-memory.mjs'
import { ProfiledMemoryStore } from '../conversation/profiled-memory-store.mjs'
import { UserProfile } from '../conversation/user-profile.mjs'
import { enforceSameOrigin } from '../core/request-security.mjs'
import { attachRealtimeGateway } from '../voice/realtime-gateway.mjs'
import { describeActiveRealtime } from '../voice/realtime-provider.mjs'
import { SessionPermissionPolicy } from '../voice/session-permission-policy.mjs'
import { taskManager, taskStore } from '../task/task-manager.mjs'
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
conversationSync.configureRetention({
  sessionTtlMs: config.conversationSessionTtlMs,
  maxSessions: config.maxConversationSessions,
})
const dynamicMemory = new FrontendMemoryStore({
  filePath: config.frontendMemoryPath,
  maxOwners: config.maxFrontendMemoryOwners,
  ownerTtlMs: config.frontendMemoryOwnerTtlMs,
})
const frontendMemory = new ProfiledMemoryStore({
  memoryStore: dynamicMemory,
  userProfile: config.identityMode === 'personal'
    ? new UserProfile({ filePath: config.userProfilePath })
    : null,
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

const server = createServer(app)
export { server }
realtimeGateway = attachRealtimeGateway(server, {
  identityManager,
  memoryStore: frontendMemory,
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
    })
  }
  console.log(`qwen-audio-agent running at ${origin}`)
})
