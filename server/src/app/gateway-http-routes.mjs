import express from 'express'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { runWithLogContext } from '../core/logger.mjs'
import { describeActiveRealtime } from '../voice/realtime-provider.mjs'
import { PERMISSION_DECISIONS } from '../core/work-authorization.mjs'
import { enforceSameOrigin, isAllowedOrigin } from '../core/request-security.mjs'
import { gatewayBrowserPairingPage } from '../access/browser-pairing-page.mjs'
import {
  GATEWAY_CAPABILITIES,
  GATEWAY_PROTOCOL_VERSION,
} from '../core/gateway-protocol.mjs'
import { registerWebRtcIngress } from '../transport/webrtc/routes.mjs'
import { webDistributionPath } from '../core/install-paths.mjs'
import {
  projectGatewayTaskEvent,
  projectGatewayTaskSnapshot,
} from '../transport/gateway-task-event-projector.mjs'
import {
  projectGatewayTaskEventForFormat,
} from '../transport/agui-event-projector.mjs'
import { startSseKeepAlive } from '../transport/sse-keepalive.mjs'
import {
  gatewayDeviceConnectionResponse,
  parseGatewayConnectionEndpoint,
} from '../access/device-connection.mjs'
import { replaySession } from '../session/session-replay.mjs'

/** Register HTTP adapters using already-assembled services; owns no service lifecycle. */
export function registerGatewayHttpRoutes(app, {
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
  getGateway,
}) {
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
    getGateway()?.disconnectCredential(credentialId)
    return res.status(204).end()
  })

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
      voiceClients: getGateway()?.status() || {
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
    startSseKeepAlive(res)
    const unsubscribe = taskManager.subscribe(event => {
      if (event.ownerId === req.identity.ownerId && event.task.id === req.params.id) {
        const publicEvent = projectGatewayTaskEvent(event)
        if (publicEvent) write(projectEvent(publicEvent))
      }
    })
    res.on('close', unsubscribe)
  })

  // Omitted feature routes stay absent; unknown API paths must not serve the SPA.
  const webRtcIngress = registerWebRtcIngress(app, {
    options: webrtc,
    logger,
    getGateway,
    providerRegistry: realtimeProviderRegistry,
    providerName: realtimeProvider,
  })
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
  return webRtcIngress
}
