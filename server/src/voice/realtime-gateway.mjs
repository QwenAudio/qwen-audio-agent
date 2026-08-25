import { WebSocket, WebSocketServer } from 'ws'
import { randomUUID } from 'node:crypto'
import {
  GatewayClientEvent,
  GatewayServerEvent,
  isGatewayClientEvent,
} from '../../../shared/realtime-events.mjs'
import { AnnouncementManager } from './announcement/announcement-manager.mjs'
import { AnnouncementWindow } from './announcement/announcement-window.mjs'
import { config } from '../core/config.mjs'
import { logger } from '../core/logger.mjs'
import { conversationSync } from '../conversation/conversation-sync.mjs'
import { InputAssetRegistry } from './input-asset-registry.mjs'
import { normalizeClientContext } from '../conversation/frontend-agent-context.mjs'
import {
  createRealtimeFrontend,
  defaultRealtimeProviderRegistry,
  realtimeEventErrorMessage,
} from './realtime-provider.mjs'
import { isAllowedOrigin } from '../core/request-security.mjs'
import { taskManager } from '../task/task-manager.mjs'
import { TaskDomainEvent } from '../task/task-events.mjs'
import { recordTaskResult } from '../conversation/task-result-projector.mjs'
import { projectGatewayTaskEvent } from '../transport/gateway-task-event-projector.mjs'
import { ToolCallHandler } from './tools/tool-call-handler.mjs'
import { TurnTranscripts } from './tools/turn-transcripts.mjs'
import { TurnCorrelation } from './turn-correlation.mjs'
import { streamingInputTranscript } from './input-transcript.mjs'
import {
  ensureResponseContext,
  mergeResponseContext,
  responseActivityContextPatch,
} from './response-context.mjs'
import {
  ActiveVoiceClients,
  clientVoiceCapabilities,
} from './active-voice-clients.mjs'
import { ReconnectBackoff } from './reconnect-backoff.mjs'
import { realtimeConnectionStatus } from './realtime-connection-status.mjs'
import { SleepController } from './sleep-controller.mjs'
import { createSherpaWakeWordDetector } from './wake-word/sherpa-detector.mjs'
import {
  evaluateResponseGuards,
  isResponseGuardTurnCurrent,
} from './response-guards/index.mjs'
import {
  isResponseActivityEvent,
  realtimeResponseId,
} from './response-lifecycle.mjs'
import {
  displayInputText,
  inputFileParts,
  inputText,
  normalizeInputParts,
  withAttachmentAnchors,
} from '../../../shared/input-parts.mjs'

const MAX_PENDING_AUDIO_CHUNKS = 30
const RESPONSE_START_WATCHDOG_MS = 12000
const PERMISSION_RESPONSE_GRACE_MS = 800
const RESPONSE_CONTEXT_CLEANUP_MS = 30000
const REALTIME_STABLE_CONNECTION_MS = 10000

function send(ws, event) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event))
}

function rejectUpgrade(socket, status, message) {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${message}`)
  socket.destroy()
}

export function rejectUnsupportedRealtimeUpgrade(socket, pathname) {
  if (pathname === '/api/realtime') return false
  socket.destroy()
  return true
}

export function isSleepActivityEvent(event = {}) {
  return isResponseActivityEvent(event) || [
    'input_audio_buffer.speech_started',
    'input_audio_buffer.speech_stopped',
    'conversation.item.input_audio_transcription.delta',
    'conversation.item.input_audio_transcription.completed',
  ].includes(event.type)
}

export function confirmsTaskNotificationOnPlaybackStart(context) {
  return Boolean(
    context
    && (
      context.origin === 'announcement'
      || context.consumesTaskNotification
    ),
  )
}

export function acceptsPlaybackReceipt({
  outputEnabled,
  active,
  responseKnown,
}) {
  return outputEnabled === true && active === true && responseKnown === true
}

function clientDescriptor(event = {}) {
  const type = ['desktop', 'cli', 'web'].includes(event.clientType)
    ? event.clientType
    : 'web'
  const label = String(event.clientLabel || '').trim().slice(0, 40)
  return {
    type,
    ...(label ? { label } : {}),
    instanceId: String(event.clientInstanceId || '').trim().slice(0, 80) || null,
  }
}

export function attachRealtimeGateway(server, {
  identityManager,
  memoryService,
  memoryExtractor = null,
  notesStore,
  coordinator,
  backendAvailability = null,
  respondPermission,
  permissionPolicy,
  inputAssets = new InputAssetRegistry(),
  inputArbitration = null,
  realtimeProviderRegistry = defaultRealtimeProviderRegistry,
  defaultRealtimeProvider = config.audioProvider,
}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 20 * 1024 * 1024 })
  const activeVoiceClients = new ActiveVoiceClients()
  const voiceConnections = new Map()

  // A suspension is global, not per owner: the host is taking the machine's
  // microphone, so every connected client has to let go of it. The subscription
  // lives as long as this WebSocket server.
  inputArbitration?.subscribe(status => {
    for (const clients of voiceConnections.values()) {
      for (const client of clients) {
        client.applyInputSuspension?.(status)
      }
    }
  })

  const broadcastVoiceOwnership = ownerId => {
    const active = activeVoiceClients.active(ownerId)
    const holder = active?.descriptor || null
    for (const client of voiceConnections.get(ownerId) || []) {
      send(client.ws, {
        type: 'voice.ownership',
        state: active === client
          ? 'active'
          : holder ? 'busy' : 'available',
        holder,
      })
    }
  }

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, 'http://localhost')
    if (rejectUnsupportedRealtimeUpgrade(socket, url.pathname)) return
    if (!isAllowedOrigin(request)) {
      rejectUpgrade(socket, '403 Forbidden', 'origin not allowed')
      return
    }
    const identity = identityManager.resolveUpgrade(request)
    if (!identity) {
      rejectUpgrade(socket, '401 Unauthorized', 'identity required')
      return
    }
    wss.handleUpgrade(request, socket, head, ws => {
      wss.emit('connection', ws, url, identity)
    })
  })

  wss.on('connection', (ws, url, identity) => {
    const ownerId = identity.ownerId
    const sessionId = url.searchParams.get('sessionId') || 'main'
    const connectionLogger = logger.child({
      subsystem: 'realtime',
      ownerId,
      sessionId,
    })
    connectionLogger.info('voice_client.connected')
    let frontend
    let connectPromise
    let pendingAudio = []
    let turnId = ''
    let turnGeneration = 0
    let turnSequence = 0
    let committedTurnId = ''
    let committedTurnGeneration = 0
    let userSpeaking = false
    let inputEnabled = false
    let outputEnabled = false
    // Set only by host arbitration. Unlike inputEnabled (which the client
    // declares about itself) this means the client has been ordered to stop
    // capturing, so nothing here may re-enable audio on its own.
    let inputSuspended = inputArbitration?.suspended === true
    let nonVoiceClient = false
    // Realtime front end for this session. Defaults to the configured provider
    // and can be switched by the client through the connect event.
    let sessionProvider = defaultRealtimeProvider
    let descriptor = clientDescriptor()
    let responseTurnCandidate = null
    let manualInputGeneration = null
    let responseStartWatchdog = null
    let permissionResponseTimer = null
    let scheduledRealtimeReconnect = null
    let realtimeConnectedAt = 0
    let realtimeBlockedError = ''
    let sleeping = false
    let waking = false
    let explicitSleepRequested = false
    let wakeDetector = null
    let wakeDetectorPromise = null
    let sleepController
    const realtimeReconnectBackoff = new ReconnectBackoff()
    const announcementWindow = new AnnouncementWindow()
    const playbackTurns = new Map()
    const notificationClaimantId = `voice_${randomUUID()}`
    let clientContext = normalizeClientContext()
    const responseContexts = new Map()
    const inputTurns = new TurnCorrelation()
    const transcripts = new TurnTranscripts()
    const announcedPermissions = new Set()
    let permissionRetryTimer = null
    const activeSessionTasks = () => taskManager.list({
      ownerId,
      sessionId,
      active: true,
    })
    const schedulePermissionRetry = () => {
      if (permissionRetryTimer || !outputEnabled || !frontend?.ready) return
      permissionRetryTimer = setTimeout(() => {
        permissionRetryTimer = null
        announcePendingPermissions()
      }, Math.max(100, config.announcementQuietMs))
      permissionRetryTimer.unref?.()
    }
    const announcePermission = task => {
      const permission = task?.authorization
      if (
        !outputEnabled
        || !frontend?.ready
        || permission?.status !== 'pending'
        || announcedPermissions.has(permission.id)
      ) return
      if (userSpeaking || announcementWindow.isBlocked()) {
        schedulePermissionRetry()
        return
      }
      announcedPermissions.add(permission.id)
      frontend.injectPermission(permission, {
        turnId: task.turnId,
        taskId: task.id,
        authorizationId: permission.id,
      }, {
        shouldSpeak: () => activeSessionTasks().some(activeTask => (
          activeTask.authorization?.id === permission.id
          && activeTask.authorization.status === 'pending'
        )),
      }).then(outcome => {
        if (outcome?.completed) return
        announcedPermissions.delete(permission.id)
        schedulePermissionRetry()
      }).catch(error => {
        announcedPermissions.delete(permission.id)
        schedulePermissionRetry()
        send(ws, {
          type: 'error',
          message: `暂时无法询问权限：${error.message}`,
        })
      })
    }
    const announcePendingPermissions = () => {
      const activeTasks = activeSessionTasks()
      const pendingIds = new Set(activeTasks
        .filter(task => task.authorization?.status === 'pending')
        .map(task => task.authorization.id))
      for (const id of announcedPermissions) {
        if (!pendingIds.has(id)) announcedPermissions.delete(id)
      }
      activeTasks.forEach(announcePermission)
    }
    const announcements = new AnnouncementManager({
      getFrontend: () => frontend,
      isDeliveryBlocked: () => sleeping || waking || !outputEnabled || announcementWindow.isBlocked(),
      announceIntoContext: config.announceIntoContext,
      resultContextMaxChars: config.resultContextMaxChars,
      maxBatchItems: config.announcementMaxBatchItems,
      batchWindowMs: config.announcementBatchMs,
      acknowledgementTimeoutMs: config.announcementAcknowledgementTimeoutMs,
      maxRetryAttempts: config.announcementMaxRetryAttempts,
      leaseRenewIntervalMs: Math.max(
        1000,
        Math.floor(config.taskNotificationClaimTtlMs / 3),
      ),
      onDelivered: taskIds => taskManager.markNotificationsDelivered(taskIds, {
        claimantId: notificationClaimantId,
      }),
      onLeaseRenew: taskIds => taskManager.renewNotificationClaims(taskIds, {
        claimantId: notificationClaimantId,
      }),
      onRelease: taskIds => taskManager.releaseNotificationClaims(taskIds, {
        claimantId: notificationClaimantId,
      }),
      onError: error => send(ws, {
        type: 'error',
        message: `后台结果暂时无法播报，正在自动重试：${error.message}`,
      }),
    })
    const voiceClient = {
      ws,
      descriptor,
      // Commands this client to release or reclaim the microphone. Playback
      // stops together with capture: a host that is recording must not pick up
      // this Gateway's own speech.
      applyInputSuspension: status => {
        const suspend = status.suspended === true
        if (suspend === inputSuspended) return
        inputSuspended = suspend
        if (suspend) {
          // Buffered audio predates the suspension and is no longer wanted.
          pendingAudio = []
          sleepController?.disable()
          frontend?.cancel()
          send(ws, { type: GatewayServerEvent.PLAYBACK_CLEAR, reason: 'input_suspended' })
          send(ws, {
            type: GatewayServerEvent.INPUT_SUSPEND,
            owner: status.owner,
            reason: status.reason,
            expiresAt: status.expiresAt,
          })
          return
        }
        send(ws, { type: GatewayServerEvent.INPUT_RESUME })
        prepareSleepMode()
      },
      realtimeStatus: () => realtimeConnectionStatus({
        provider: sessionProvider,
        blockedError: realtimeBlockedError,
        sleeping,
        waking,
        ready: frontend?.ready === true,
        connecting: Boolean(connectPromise),
      }),
      // Lets the arbitration evict this owner once its socket has died without
      // a clean close, so a stale holder never blocks a new voice claim.
      isAlive: () => ws.readyState === WebSocket.OPEN,
      deactivate: replacement => {
        sleeping = false
        waking = false
        sleepController?.disable()
        inputEnabled = false
        outputEnabled = false
        pendingAudio = []
        announcementWindow.reset()
        announcements.pause()
        cancelScheduledRealtimeReconnect()
        frontend?.close()
        send(ws, { type: 'playback.clear' })
        send(ws, {
          type: 'voice.deactivated',
          holder: replacement?.descriptor || null,
        })
      },
    }
    if (!voiceConnections.has(ownerId)) voiceConnections.set(ownerId, new Set())
    voiceConnections.get(ownerId).add(voiceClient)

    const activateVoiceClient = ({
      takeover = false,
      enableInput = true,
      enableOutput = true,
    } = {}) => {
      const result = activeVoiceClients.activate(
        ownerId,
        voiceClient,
        { takeover },
      )
      inputEnabled = result.granted && enableInput
      outputEnabled = result.granted && enableOutput
      broadcastVoiceOwnership(ownerId)
      return result.granted
    }
    const releaseVoiceClient = () => {
      inputEnabled = false
      outputEnabled = false
      if (activeVoiceClients.release(ownerId, voiceClient)) {
        broadcastVoiceOwnership(ownerId)
      }
    }
    const toolCalls = new ToolCallHandler({
      taskManager,
      ownerId,
      sessionId,
      transcripts,
      getFrontend: () => frontend,
      getTurnId: () => committedTurnId,
      getTurnGeneration: () => committedTurnGeneration,
      memoryService,
      notesStore,
      getClientContext: () => clientContext,
      getConversationContext: () => conversationSync.frontendContext({
        ownerId,
        sessionId,
      }),
      onMemoryChanged: () => frontend?.updateAgentContext({
        memories: memoryService?.list(ownerId, { limit: 64 }) || [],
      }),
      coordinator,
      backendAvailability,
      respondPermission,
      permissionPolicy,
      // The permission decision was accepted locally but never reached the
      // backend: the authorization is still pending there, so clear the
      // announced mark and let the standard re-announce path ask again.
      onPermissionDeliveryFailed: ({ authorizationId, error }) => {
        connectionLogger.warn('permission.delivery_failed', {
          authorizationId,
          error,
        })
        announcedPermissions.delete(authorizationId)
        announcePendingPermissions()
      },
      requestClientState: state => {
        if (!clientContext.states?.includes(state)) return
        send(ws, {
          type: GatewayServerEvent.CLIENT_STATE,
          state,
        })
        if (state === 'sleeping') enterSleep()
      },
      onAgentActivity: activity => send(ws, {
        type: GatewayServerEvent.AGENT_ACTIVITY,
        ...activity,
      }),
      inputAssets,
    })
    const currentTurn = () => ({
      turnId,
      turnGeneration,
    })
    const rememberInputTurn = (itemId, context) => {
      inputTurns.remember(itemId, context)
    }
    const inputTurn = event => (
      inputTurns.resolve(event.item_id, currentTurn())
    )
    const commitTurn = context => {
      if (!context?.turnId) return
      if (
        committedTurnId === context.turnId
        && committedTurnGeneration === context.turnGeneration
      ) return
      if (context.turnGeneration < committedTurnGeneration) return
      committedTurnId = context.turnId
      committedTurnGeneration = context.turnGeneration
    }
    const clearResponseCandidate = () => {
      clearTimeout(responseStartWatchdog)
      clearTimeout(permissionResponseTimer)
      responseStartWatchdog = null
      permissionResponseTimer = null
      responseTurnCandidate = null
    }

    const cancelScheduledRealtimeReconnect = () => {
      const scheduled = scheduledRealtimeReconnect
      if (!scheduled) return
      scheduledRealtimeReconnect = null
      clearTimeout(scheduled.timer)
      scheduled.resolve()
    }

    const scheduleRealtimeReconnect = () => {
      if (realtimeBlockedError) return Promise.resolve()
      if (frontend?.ready) return Promise.resolve()
      if (scheduledRealtimeReconnect) {
        return scheduledRealtimeReconnect.promise
      }
      let resolveScheduled
      let rejectScheduled
      const promise = new Promise((resolve, reject) => {
        resolveScheduled = resolve
        rejectScheduled = reject
      })
      const scheduled = {
        promise,
        resolve: resolveScheduled,
        reject: rejectScheduled,
        timer: null,
      }
      scheduled.timer = setTimeout(() => {
        if (scheduledRealtimeReconnect !== scheduled) {
          scheduled.resolve()
          return
        }
        // Clear the waiting state before connecting. If this attempt closes,
        // its onClose callback can schedule the next backoff step without
        // colliding with the promise for the attempt that just started.
        scheduledRealtimeReconnect = null
        connectFrontendNow().then(scheduled.resolve, scheduled.reject)
      }, realtimeReconnectBackoff.next())
      scheduled.timer.unref?.()
      scheduledRealtimeReconnect = scheduled
      return promise
    }
    const reportFrontendError = error => {
      if (error?.realtimeConnectionReported) return
      if (error) error.realtimeConnectionReported = true
      send(ws, { type: 'error', message: error?.message || String(error) })
    }
    const ensurePermissionResponseFor = context => {
      clearTimeout(permissionResponseTimer)
      const hasPendingPermission = () => activeSessionTasks().some(task => (
        task.authorization?.status === 'pending'
      ))
      if (!hasPendingPermission()) return
      permissionResponseTimer = setTimeout(() => {
        permissionResponseTimer = null
        frontend?.ensureResponse({
          turnId: context.turnId,
          turnGeneration: context.turnGeneration,
        }, {
          shouldCreate: () => {
            if (
              responseTurnCandidate !== context
              || !hasPendingPermission()
            ) return false
            clearResponseCandidate()
            return true
          },
        }).catch(error => send(ws, {
          type: 'error',
          message: `暂时无法处理权限回答：${error.message}`,
        }))
      }, PERMISSION_RESPONSE_GRACE_MS)
      permissionResponseTimer.unref?.()
    }
    const expectResponseFor = context => {
      clearResponseCandidate()
      responseTurnCandidate = context
      responseStartWatchdog = setTimeout(() => {
        if (responseTurnCandidate !== context) return
        clearResponseCandidate()
        send(ws, {
          type: 'error',
          message: '实时模型没有开始回复，语音连接已自动恢复，请再说一次。',
        })
        send(ws, {
          type: 'voice.state',
          state: 'idle',
          turnId: context.turnId,
          origin: 'model',
        })
        const staleFrontend = frontend
        frontend = null
        staleFrontend?.close()
        scheduleRealtimeReconnect().catch(error => send(ws, {
          type: 'error',
          message: error.message,
        }))
      }, frontend?.provider.responseStartTimeoutMs ?? RESPONSE_START_WATCHDOG_MS)
      responseStartWatchdog.unref?.()
    }

    const queueNotification = task => {
      if (task.status === 'completed') {
        announcements.completed(task)
      }
      if (task.status === 'failed') announcements.failed(task)
    }

    const recordResult = task => recordTaskResult({
      conversationSync,
      ownerId,
      sessionId,
      task,
    })

    const contextTaskIds = context => (
      context?.taskIds?.length ? context.taskIds : [context?.taskId].filter(Boolean)
    )

    const publicResponseContext = context => ({
      turnId: context.turnId,
      taskId: context.taskId,
      taskIds: context.taskIds,
      turnIds: context.turnIds,
      origin: context.origin,
      turnGeneration: context.turnGeneration,
      deliverySequence: context.deliverySequence,
    })

    const fallbackResponseContext = () => ({
      turnId: committedTurnId || turnId,
      taskId: null,
      origin: 'model',
      turnGeneration: committedTurnId
        ? committedTurnGeneration
        : turnGeneration,
    })

    const emitAssistantTranscript = ({
      id,
      context,
      content,
      final,
    }) => {
      if (final) {
        conversationSync.record({
          ownerId,
          sessionId,
          id: `voice:assistant:${id}`,
          role: 'assistant',
          content,
          source: context.origin === 'model' ? 'realtime-direct' : 'agent-presentation',
          ...context,
        })
      }
      send(ws, {
        type: final ? 'transcript.final' : 'transcript.delta',
        role: 'assistant',
        content: content || '',
        responseId: id,
        ...publicResponseContext(context),
      })
    }

    const flushPendingTranscripts = (id, context) => {
      for (const transcript of context?.pendingTranscripts || []) {
        emitAssistantTranscript({
          id,
          context,
          content: transcript.content,
          final: transcript.final,
        })
      }
      if (context) context.pendingTranscripts = []
    }

    const finishResponseContextIfComplete = (id, context) => {
      if (
        context
        && context.playbackEnded
        && context.responseDone
        && context.transcriptDone
      ) {
        responseContexts.delete(id)
      }
    }

    const scheduleResponseContextCleanup = (id, context) => {
      const timer = setTimeout(() => {
        if (responseContexts.get(id) !== context) return
        responseContexts.delete(id)
        playbackTurns.delete(id)
        announcementWindow.finishPlayback(id, {
          hasFunctionCall: Boolean(context?.hasFunctionCall),
        })
      }, RESPONSE_CONTEXT_CLEANUP_MS)
      timer.unref?.()
    }

    const startPlayback = id => {
      const context = responseContexts.get(id)
      // A cancelled response remains as a short-lived tombstone so late
      // provider audio and client receipts cannot resurrect it.
      if (context?.suppressed) return
      announcementWindow.startPlayback(id)
      const playbackTurnId = context?.turnId || playbackTurns.get(id) || turnId
      send(ws, {
        type: 'voice.state',
        state: 'speaking',
        turnId: playbackTurnId,
        origin: context?.origin || 'model',
      })
      if (!context || context.playbackStarted) return
      context.playbackStarted = true
      if (confirmsTaskNotificationOnPlaybackStart(context)) {
        announcements.confirmMany(contextTaskIds(context))
      }
      flushPendingTranscripts(id, context)
    }

    const cancelQueuedPlayback = (id, { reason = '' } = {}) => {
      const context = responseContexts.get(id)
      announcementWindow.finishPlayback(id, {
        hasFunctionCall: Boolean(context?.hasFunctionCall),
      })
      const playbackTurnId = playbackTurns.get(id) || turnId
      playbackTurns.delete(id)
      if (context?.origin === 'announcement') {
        if (reason === 'user_interruption') {
          announcements.confirmMany(contextTaskIds(context))
        } else {
          announcements.retryMany(contextTaskIds(context))
        }
      }
      if (context?.playbackStarted && reason === 'user_interruption') {
        send(ws, {
          type: 'response.interrupted',
          responseId: id,
          ...publicResponseContext(context),
        })
      }
      if (context) {
        context.suppressed = true
        context.playbackEnded = true
        context.pendingTranscripts = []
        scheduleResponseContextCleanup(id, context)
      }
      send(ws, {
        type: 'voice.state',
        state: userSpeaking ? 'listening' : 'idle',
        turnId: userSpeaking ? turnId : playbackTurnId,
        origin: context?.origin || 'model',
      })
      const timer = setTimeout(
        () => announcements.flush(),
        config.announcementQuietMs,
      )
      timer.unref?.()
    }

    const beginResponseLifecycle = event => {
      const id = realtimeResponseId(event)
      if (!id) return null
      const existing = responseContexts.get(id)
      const automaticResponse = (
        !existing
        && (event.__voiceOrigin || 'model') === 'model'
        && !event.__voiceContext?.turnId
      )
      const automaticTurn = automaticResponse
        ? responseTurnCandidate
        : null
      const fallback = {
        turnId: event.__voiceContext?.turnId
          || automaticTurn?.turnId
          || committedTurnId
          || turnId,
        taskId: event.__voiceContext?.taskId || null,
        origin: event.__voiceOrigin || 'model',
        authorizationId: event.__voiceContext?.authorizationId || null,
        turnGeneration: Number.isInteger(event.__voiceContext?.turnGeneration)
          ? event.__voiceContext.turnGeneration
          : automaticTurn?.turnGeneration
            ?? (committedTurnId ? committedTurnGeneration : turnGeneration),
      }
      const context = mergeResponseContext(
        responseContexts,
        id,
        responseActivityContextPatch({ existing, event, fallback }),
      )
      if (
        manualInputGeneration !== null
        && !automaticResponse
        && context.turnGeneration === manualInputGeneration
        && context.origin === 'model'
      ) {
        manualInputGeneration = null
      }
      // Compatible Realtime servers may omit response.created and reveal the
      // correlation only on response.done. If audio already reached the
      // client, confirm the newly identified task notification immediately.
      if (
        context.playbackStarted
        && confirmsTaskNotificationOnPlaybackStart(context)
      ) {
        announcements.confirmMany(contextTaskIds(context))
      }
      if (automaticTurn) {
        // Some OpenAI-compatible servers start an implicit server-VAD response
        // with transcript or audio output and omit response.created. Any valid
        // response output proves that turn detection accepted this turn.
        commitTurn(automaticTurn)
        clearResponseCandidate()
      }
      if (!context.responseStarted) {
        context.responseStarted = true
        send(ws, {
          type: 'response.started',
          responseId: id,
          ...publicResponseContext(context),
        })
      }
      return context
    }

    const finishPlayback = id => {
      const playbackTurnId = playbackTurns.get(id) || turnId
      const context = responseContexts.get(id)
      if (context?.suppressed) {
        playbackTurns.delete(id)
        return
      }
      announcementWindow.finishPlayback(id, {
        hasFunctionCall: Boolean(context?.hasFunctionCall),
      })
      playbackTurns.delete(id)
      if (context) {
        context.playbackEnded = true
        finishResponseContextIfComplete(id, context)
        if (responseContexts.get(id) === context) {
          scheduleResponseContextCleanup(id, context)
        }
      }
      send(ws, {
        type: 'voice.state',
        state: userSpeaking ? 'listening' : 'idle',
        turnId: userSpeaking ? turnId : playbackTurnId,
        origin: context?.origin || 'model',
      })
      const timer = setTimeout(
        () => announcements.flush(),
        config.announcementQuietMs,
      )
      timer.unref?.()
    }

    const claimPendingNotifications = (
      taskIds,
      { includeOtherSessions = !taskIds?.length } = {},
    ) => {
      if (!outputEnabled || !frontend?.ready) return
      const claimed = taskManager.claimNotifications({
        ownerId,
        sessionId,
        includeOtherSessions,
        claimantId: notificationClaimantId,
        taskIds,
      })
      claimed.forEach(task => {
        recordResult(task)
        queueNotification(task)
      })
    }

    const unsubscribeTasks = taskManager.subscribe(event => {
      const task = event.task
      if (event.ownerId !== ownerId) return
      if (event.type === TaskDomainEvent.PROGRESS_CHECK) {
        if (task.sessionId !== sessionId) return
        if (!outputEnabled || !frontend?.ready) return
        const progressContext = {
          taskId: task.id,
          turnId: null,
          taskIds: [task.id],
          deliverySequence: null,
        }
        const progressText = [
          '[PROGRESS]',
          '<qwen_audio_agent_progress>',
          '这是后台任务的进度更新，不是最终结果，也不是用户的新请求。',
          '用一句自然的话简短说明进度，不要调用工具。',
          event.message,
          '</qwen_audio_agent_progress>',
        ].join('\n')
        frontend.injectResult(
          progressText,
          'progress',
          progressContext,
          { injectContext: true },
        ).catch(error => {
          connectionLogger.warn('progress.injection_failed', {
            taskId: task.id,
            error: error.message,
          })
        })
        return
      }
      if (event.type === TaskDomainEvent.NOTIFICATION_PENDING) {
        if (sleeping) {
          wakeFromSleep()
          return
        }
        if (task.sessionId === sessionId) {
          claimPendingNotifications([task.id])
        }
        return
      }
      if (task.sessionId !== sessionId) return
      const publicEvent = projectGatewayTaskEvent(event)
      if (publicEvent) send(ws, publicEvent)
      if (event.type === TaskDomainEvent.PERMISSION_REQUESTED) {
        if (sleeping) {
          wakeFromSleep()
          return
        }
        announcePermission(task)
      }
      if (event.type === TaskDomainEvent.PERMISSION_RESOLVED) {
        const authorizationId = event.permission?.id
        if (authorizationId) {
          // 已进入对话的权限询问被其它通道（如 WebUI 按钮）处理后，把结果
          // 静默回注模型上下文：避免模型不知情而重复追问，或把用户随后的
          // 口头确认误报为“请求已失效”。
          if (announcedPermissions.has(authorizationId) && frontend?.ready) {
            frontend.appendUserInputContext([{
              type: 'text',
              text: '（系统提示：刚才的后台权限请求已处理完毕，任务继续执行；'
                + '无需再询问或回应该请求。）',
            }]).catch(() => {})
          }
          announcedPermissions.delete(authorizationId)
          frontend?.cancelResponses((context, origin) => (
            origin === 'permission'
            && context?.authorizationId === authorizationId
          ))
          for (const [responseId, context] of responseContexts) {
            if (
              context.origin === 'permission'
              && context.authorizationId === authorizationId
              && !context.suppressed
            ) {
              cancelQueuedPlayback(responseId, {
                reason: 'permission_resolved',
              })
            }
          }
        }
      }
      if (event.type === TaskDomainEvent.DELEGATED) {
        const presentation = task.delegation?.presentation
        if (presentation?.inline?.content) {
          send(ws, {
            type: 'timeline.inline',
            item: {
              id: `inline_${task.id}_delegated`,
              taskId: task.id,
              turnId: task.turnId || null,
              ...presentation.inline,
            },
          })
        }
      }
      if ([
        TaskDomainEvent.COMPLETED,
        TaskDomainEvent.FAILED,
      ].includes(event.type)) {
        recordResult(task)
        const inline = task.resultMetadata?.presentation?.inline
        if (inline?.content) {
          send(ws, {
            type: 'timeline.inline',
            item: {
              id: `inline_${task.id}`,
              taskId: task.id,
              turnId: task.turnId || null,
              ...inline,
            },
          })
        }
        claimPendingNotifications([task.id])
      }
    })

    const handleEvent = event => {
      if (isSleepActivityEvent(event)) sleepController?.recordActivity()
      if (isResponseActivityEvent(event)) beginResponseLifecycle(event)
      if (event.type === 'input_audio_buffer.speech_started') {
        // A discrete text/image submission owns the turn until its response
        // starts. Provider-side VAD events caused by audio already in flight
        // belong to the superseded voice turn and must not take ownership back.
        if (manualInputGeneration !== null) {
          inputTurns.invalidate(event.item_id)
          return
        }
        userSpeaking = true
        clearResponseCandidate()
        const knownTurn = event.item_id
          ? inputTurns.resolve(event.item_id, null)
          : null
        if (knownTurn) {
          turnId = knownTurn.turnId
          turnGeneration = knownTurn.turnGeneration
        } else {
          turnGeneration = ++turnSequence
          turnId = `voice-${Date.now()}-${turnGeneration}`
          rememberInputTurn(event.item_id, currentTurn())
        }
        announcementWindow.beginTurn(turnId)
        announcements.dismissActive()
        send(ws, {
          type: 'playback.clear',
          reason: 'user_interruption',
        })
        send(ws, { type: 'turn.started', turnId })
        send(ws, { type: 'voice.state', state: 'listening', turnId })
        frontend?.cancel()
      } else if (event.type === 'input_audio_buffer.speech_stopped') {
        const stoppedTurn = inputTurn(event)
        if (
          inputTurns.isInvalid(event.item_id)
          || stoppedTurn?.turnGeneration < committedTurnGeneration
        ) {
          inputTurns.invalidate(event.item_id)
          return
        }
        userSpeaking = false
        announcementWindow.endSpeech()
        if (event.reason === 'turn_invalid') {
          if (event.item_id) {
            inputTurns.invalidate(event.item_id)
          }
          send(ws, {
            type: 'transcript.discard',
            role: 'user',
            turnId: stoppedTurn.turnId,
            reason: 'turn_invalid',
          })
          send(ws, {
            type: 'voice.state',
            state: 'idle',
            turnId: stoppedTurn.turnId,
            origin: 'model',
          })
        } else {
          expectResponseFor(stoppedTurn)
          send(ws, {
            type: 'voice.state',
            state: 'processing',
            turnId: stoppedTurn.turnId,
            origin: 'model',
          })
        }
      } else if (event.type === 'input_audio_buffer.committed') {
        const committedInputTurn = inputTurn(event)
        if (
          inputTurns.isInvalid(event.item_id)
          || committedInputTurn?.turnGeneration < committedTurnGeneration
        ) {
          inputTurns.invalidate(event.item_id)
          return
        }
        userSpeaking = false
        announcementWindow.endSpeech()
        if (!inputTurns.isInvalid(event.item_id)) {
          send(ws, {
            type: 'voice.state',
            state: 'processing',
            turnId: committedInputTurn.turnId,
            origin: 'model',
          })
        }
      } else if (event.type === 'conversation.item.ambient_audio_transcription.completed') {
        inputTurns.complete(event.item_id, currentTurn())
      } else if (
        event.type === 'conversation.item.input_audio_transcription.delta'
        || event.type === 'conversation.item.input_audio_transcription.text'
      ) {
        if (inputTurns.isInvalid(event.item_id)) return
        const transcriptTurn = inputTurns.resolve(event.item_id, currentTurn())
        if (transcriptTurn?.turnGeneration < committedTurnGeneration) return
        const transcript = streamingInputTranscript(event)
        if (!transcriptTurn?.turnId || !transcript) return
        send(ws, {
          type: 'transcript.delta',
          role: 'user',
          content: transcript,
          turnId: transcriptTurn.turnId,
          replace: true,
        })
      } else if (event.type === 'conversation.item.input_audio_transcription.completed') {
        const completedInput = inputTurns.complete(event.item_id, currentTurn())
        const transcriptTurn = completedInput.context
        if (
          completedInput.invalid
          || transcriptTurn?.turnGeneration < committedTurnGeneration
        ) return
        const transcript = String(event.transcript || '').trim()
        if (!transcript) {
          send(ws, {
            type: 'transcript.discard',
            role: 'user',
            turnId: transcriptTurn.turnId,
          })
          return
        }
        commitTurn(transcriptTurn)
        transcripts.record(transcriptTurn.turnId, transcript)
        if (responseTurnCandidate === transcriptTurn) {
          ensurePermissionResponseFor(transcriptTurn)
        }
        conversationSync.record({
          ownerId,
          sessionId,
          id: `voice:user:${transcriptTurn.turnId}`,
          role: 'user',
          content: transcript,
          source: 'voice-user',
          turnId: transcriptTurn.turnId,
          inputs: inputAssets.metadataForParts(
            transcripts.parts(transcriptTurn.turnId),
          ),
        })
        send(ws, {
          type: 'transcript.final',
          role: 'user',
          content: transcript,
          turnId: transcriptTurn.turnId,
        })
      } else if (event.type === 'conversation.item.input_audio_transcription.failed') {
        const failedInput = inputTurns.complete(event.item_id, currentTurn())
        send(ws, {
          type: 'transcript.discard',
          role: 'user',
          turnId: failedInput.context?.turnId,
        })
      } else if (event.type === 'response.created') {
        // Lifecycle setup is handled before the event switch so providers that
        // emit output before (or instead of) response.created follow this path.
      } else if (event.type === 'response.function_call_arguments.done') {
        const id = realtimeResponseId(event)
        const callContext = responseContexts.get(id)
          || { turnId: '', turnGeneration: -1 }
        logger.info('realtime.tool_call.received', {
          responseId: id,
          callId: event.call_id || event.item?.call_id || '',
          toolName: event.name || event.item?.name || '',
          turnId: callContext.turnId || '',
        })
        if (responseContexts.has(id)) {
          responseContexts.get(id).hasFunctionCall = true
        }
        toolCalls.handle(event, { ...callContext, responseId: id }).catch(error => {
          send(ws, { type: 'error', message: error.message })
        })
      } else if (
        event.type === 'response.audio.delta'
        || event.type === 'response.output_audio.delta'
      ) {
        const id = realtimeResponseId(event)
        const responseContext = ensureResponseContext(
          responseContexts,
          id,
          fallbackResponseContext(),
        )
        if (responseContext?.suppressed) return
        const responseTurnId = responseContext.turnId || turnId
        if (id) {
          responseContext.hasAudio = true
          playbackTurns.set(id, responseTurnId)
          announcementWindow.queueAudio(id, {
            turnId: responseTurnId,
            origin: responseContext.origin || 'model',
          })
        }
        send(ws, {
          type: 'audio.delta',
          audio: event.delta,
          sampleRate: Number(event.sampleRate)
            || frontend.provider.outputSampleRate,
          responseId: id,
          turnId: responseTurnId,
        })
      } else if (
        event.type === 'response.audio_transcript.delta'
        || event.type === 'response.output_audio_transcript.delta'
      ) {
        const id = realtimeResponseId(event)
        const context = ensureResponseContext(
          responseContexts,
          id,
          fallbackResponseContext(),
        )
        if (context.suppressed) return
        if (!context.playbackStarted) {
          context.pendingTranscripts.push({
            content: event.delta || '',
            final: false,
          })
        } else {
          emitAssistantTranscript({
            id,
            context,
            content: event.delta || '',
            final: false,
          })
        }
      } else if (
        event.type === 'response.audio_transcript.done'
        || event.type === 'response.output_audio_transcript.done'
      ) {
        const id = realtimeResponseId(event)
        const context = ensureResponseContext(
          responseContexts,
          id,
          fallbackResponseContext(),
        )
        if (context.suppressed) return
        context.transcriptDone = true
        context.assistantTranscript = event.transcript || ''
        if (!context.playbackStarted) {
          context.pendingTranscripts.push({
            content: event.transcript || '',
            final: true,
          })
        } else {
          emitAssistantTranscript({
            id,
            context,
            content: event.transcript || '',
            final: true,
          })
        }
        finishResponseContextIfComplete(id, context)
      } else if (event.type === 'response.text.delta') {
        const id = realtimeResponseId(event)
        const context = ensureResponseContext(
          responseContexts,
          id,
          fallbackResponseContext(),
        )
        if (context.suppressed) return
        emitAssistantTranscript({
          id,
          context,
          content: event.delta || '',
          final: false,
        })
      } else if (event.type === 'response.text.done') {
        const id = realtimeResponseId(event)
        const context = ensureResponseContext(
          responseContexts,
          id,
          fallbackResponseContext(),
        )
        if (context.suppressed) return
        context.transcriptDone = true
        context.assistantTranscript = event.text || ''
        emitAssistantTranscript({
          id,
          context,
          content: event.text || '',
          final: true,
        })
      } else if (event.type === 'response.done') {
        const id = realtimeResponseId(event)
        const responseContext = responseContexts.get(id)
        const terminalToolResponse = toolCalls.consumeTerminalToolResponse(id)
        const responseTurnId = responseContext?.turnId || turnId
        const responseStatus = event.response?.status
        const responseFailed = ['failed', 'cancelled', 'incomplete'].includes(
          responseStatus,
        )
        toolCalls.finishToolResponse(id, {
          suppressResponse: responseFailed
            || Boolean(responseContext?.suppressed)
            || Boolean(responseContext?.hasAudio)
            || Boolean(responseContext?.assistantTranscript?.trim()),
        }).catch(error => {
          send(ws, { type: 'error', message: error.message })
        })
        // Guards run before the context is retired below, which drops the
        // transcript they inspect. They can only ask the model to reconsider;
        // they never execute tools or mutate task state directly.
        const responseGuardDecision = evaluateResponseGuards({
          origin: responseContext?.origin || 'model',
          hasFunctionCall: Boolean(responseContext?.hasFunctionCall),
          failed: responseFailed,
          suppressed: Boolean(responseContext?.suppressed),
          transcript: responseContext?.assistantTranscript || '',
        })
        if (!responseContext?.suppressed) {
          send(ws, { type: 'audio.done', responseId: id, turnId: responseTurnId })
          if (!responseContext?.hasAudio) {
            send(ws, {
              type: 'voice.state',
              state: 'idle',
              turnId: responseTurnId,
              origin: responseContext?.origin || 'model',
            })
          }
        }
        if (responseContext?.hasAudio && !responseFailed) {
          responseContext.responseDone = true
          finishResponseContextIfComplete(id, responseContext)
        } else {
          const completedNonVoiceAnnouncement = (
            responseContext?.origin === 'announcement'
            && nonVoiceClient
            && !responseFailed
          )
          const completedNonVoiceTaskNotification = (
            responseContext?.consumesTaskNotification
            && nonVoiceClient
            && !responseFailed
          )
          if (
            responseContext
            && !responseFailed
            && (
              responseContext.origin !== 'announcement'
              || completedNonVoiceAnnouncement
            )
          ) {
            flushPendingTranscripts(id, responseContext)
          }
          if (responseContext?.origin === 'announcement') {
            if (completedNonVoiceAnnouncement) {
              announcements.confirmMany(contextTaskIds(responseContext))
            } else {
              announcements.retryMany(contextTaskIds(responseContext))
            }
          } else if (completedNonVoiceTaskNotification) {
            announcements.confirmMany(contextTaskIds(responseContext))
          }
          responseContexts.delete(id)
        }
        if (responseFailed && id) {
          playbackTurns.delete(id)
          announcementWindow.finishPlayback(id, {
            hasFunctionCall: Boolean(responseContext?.hasFunctionCall),
          })
        }
        announcementWindow.responseDone({
          turnId: responseTurnId,
          origin: responseContext?.origin || 'model',
          hasAudio: Boolean(responseContext?.hasAudio),
          hasFunctionCall: Boolean(responseContext?.hasFunctionCall),
          suppressed: Boolean(responseContext?.suppressed) || terminalToolResponse,
          failed: responseFailed,
        })
        if (
          responseGuardDecision
          && outputEnabled
          && frontend?.ready
          && frontend.capabilities.perResponseInstructions
        ) {
          const correctionFrontend = frontend
          const correctionGeneration = responseContext?.turnGeneration
          correctionFrontend.ensureResponse({
            turnId: responseTurnId,
            turnGeneration: correctionGeneration,
          }, {
            shouldCreate: () => isResponseGuardTurnCurrent({
              sameFrontend: frontend === correctionFrontend,
              outputEnabled,
              userSpeaking,
              responseTurnId,
              responseTurnGeneration: correctionGeneration,
              committedTurnId,
              committedTurnGeneration,
            }),
            response: {
              instructions: responseGuardDecision.instructions,
            },
          }).catch(error => send(ws, { type: 'error', message: error.message }))
        }
        const timer = setTimeout(
          () => announcements.flush(),
          config.announcementQuietMs,
        )
        timer.unref?.()
      } else if (event.type === 'error') {
        // A response refused by a busy single-slot provider is retried by the
        // frontend transparently; nothing user-facing happened.
        if (event.__voiceRetried) return
        const errorMessage = realtimeEventErrorMessage(event)
        const providerError = frontend.provider.classifyError(errorMessage)
        const recoverableInactivity = providerError === 'inactivity'
        // A local or otherwise capacity-bounded provider can still be draining
        // the previous Session. Its close event drives the shared reconnect
        // backoff, so this transient refusal is neither a response failure nor
        // a user-facing error.
        if (providerError === 'capacity_busy') return
        const permissionSpeechCollision = (
          event.__voiceOrigin === 'permission'
          && providerError === 'input_busy'
        )
        if (permissionSpeechCollision) {
          schedulePermissionRetry()
          return
        }
        // 取消撞上已完成响应的良性竞态:提供方回"无进行中响应",对用户无意义,
        // 也不应触发失败簿记(此时本就没有响应在跑)。
        const benignCancelRace = providerError === 'no_active_response'
        if (benignCancelRace) return
        if (providerError === 'fatal') {
          connectionLogger.error('realtime.blocked', {
            provider: sessionProvider,
            classification: providerError,
            errorMessage,
          })
          realtimeBlockedError = errorMessage
          pendingAudio = []
          cancelScheduledRealtimeReconnect()
          const blockedFrontend = frontend
          frontend = null
          blockedFrontend?.close()
          send(ws, {
            type: GatewayServerEvent.VOICE_CONNECTION,
            state: 'unavailable',
            provider: sessionProvider,
            message: errorMessage,
          })
        }
        const id = realtimeResponseId(event)
        const context = responseContexts.get(id)
        if (context?.origin === 'announcement') {
          send(ws, { type: 'playback.clear' })
          announcementWindow.finishPlayback(id)
          playbackTurns.delete(id)
          responseContexts.delete(id)
          announcements.retryMany(contextTaskIds(context))
        } else {
          if (id && context?.hasAudio) {
            send(ws, {
              type: 'audio.done',
              responseId: id,
              turnId: context.turnId || turnId,
            })
          }
          if (id && context?.hasAudio) {
            scheduleResponseContextCleanup(id, context)
          } else if (id) {
            responseContexts.delete(id)
            playbackTurns.delete(id)
          }
          announcementWindow.responseDone({
            turnId: context?.turnId || turnId,
            origin: context?.origin || 'model',
            hasAudio: Boolean(context?.hasAudio),
            hasFunctionCall: Boolean(context?.hasFunctionCall),
            failed: true,
          })
        }
        const timer = setTimeout(
          () => announcements.flush(),
          config.announcementQuietMs,
        )
        timer.unref?.()
        // A provider may close an inactive response scope while a delegated
        // backend task is still running. The task remains healthy, and any
        // pending announcement has already returned to the retry queue, so this
        // provider housekeeping event is not user-facing.
        if (!recoverableInactivity && providerError !== 'fatal') {
          send(ws, { type: 'error', message: errorMessage })
        }
      }
    }

    const connectFrontendNow = () => {
      if (frontend?.ready) return Promise.resolve()
      if (connectPromise) return connectPromise
      send(ws, {
        type: GatewayServerEvent.VOICE_CONNECTION,
        state: 'connecting',
        provider: sessionProvider,
      })
      const connectStartedAt = Date.now()
      connectionLogger.info('realtime.connecting', {
        provider: sessionProvider,
      })
      let createdFrontend
      createdFrontend = createRealtimeFrontend({
        providerName: sessionProvider,
        providerRegistry: realtimeProviderRegistry,
        agentContext: {
          client: clientContext,
          memories: memoryService?.list(ownerId, { limit: 64 }) || [],
          recentMessages: conversationSync.frontendContext({ ownerId, sessionId }),
        },
        onEvent: handleEvent,
        onDiagnostic: diagnostic => {
          const { event, ...fields } = diagnostic
          connectionLogger.warn(event, fields)
        },
        onError: error => {
          // Closing a frontend while it is still handshaking is expected when
          // the client enters sleep or reconnects. Its late socket error
          // belongs to the detached frontend and must not mark the live voice
          // client unavailable.
          if (frontend !== createdFrontend) return
          const classification = createdFrontend.provider.classifyError(error.message)
          if (classification !== 'inactivity') {
            connectionLogger.warn('realtime.provider_error', {
              provider: createdFrontend.provider.key,
              classification,
              error,
            })
          }
          if (classification === 'fatal') {
            realtimeBlockedError = error.message
            pendingAudio = []
            error.realtimeConnectionReported = true
          }
          // capacity_busy 是瞬时可恢复错误（如 s2s 单 session 槽异步未释放），
          // 由上层 wakeFromSleep 带退避重试，不向客户端报错以保持唤醒流程静默。
          if (classification !== 'inactivity' && classification !== 'capacity_busy') {
            reportFrontendError(error)
          }
        },
        onClose: () => {
          if (frontend !== createdFrontend) return
          connectionLogger.warn('realtime.closed', {
            provider: createdFrontend.provider.key,
            connectedMs: realtimeConnectedAt
              ? Date.now() - realtimeConnectedAt
              : 0,
            blocked: Boolean(realtimeBlockedError),
          })
          send(ws, { type: 'voice.state', state: 'idle' })
          frontend = null
          if (!inputEnabled && !outputEnabled) return
          send(ws, {
            type: GatewayServerEvent.VOICE_CONNECTION,
            state: 'unavailable',
            provider: sessionProvider,
            ...(realtimeBlockedError ? { message: realtimeBlockedError } : {}),
          })
          if (realtimeBlockedError) return
          if (
            realtimeConnectedAt
            && Date.now() - realtimeConnectedAt >= REALTIME_STABLE_CONNECTION_MS
          ) {
            realtimeReconnectBackoff.reset()
          }
          realtimeConnectedAt = 0
          scheduleRealtimeReconnect()
            .then(() => announcements.flush())
            .catch(error => send(ws, {
              type: 'error',
              message: `实时语音连接恢复失败：${error.message}`,
            }))
        },
      })
      frontend = createdFrontend
      let createdConnectPromise
      createdConnectPromise = createdFrontend.connect()
        .then(() => {
          if (frontend !== createdFrontend) return
          realtimeBlockedError = ''
          realtimeConnectedAt = Date.now()
          connectionLogger.info('realtime.connected', {
            provider: createdFrontend.provider.key,
            durationMs: realtimeConnectedAt - connectStartedAt,
          })
          const resumedFromSleep = waking
          waking = false
          send(ws, {
            type: GatewayServerEvent.VOICE_CONNECTION,
            state: 'connected',
            provider: createdFrontend.provider.key,
          })
          announcePendingPermissions()
          pendingAudio.forEach(audio => createdFrontend.appendAudio(audio))
          pendingAudio = []
          if (outputEnabled) claimPendingNotifications()
          send(ws, {
            type: 'voice.ready',
            inputSampleRate: createdFrontend.provider.inputSampleRate,
            provider: createdFrontend.provider.key,
            providerLabel: createdFrontend.provider.label,
          })
          prepareSleepMode()
          sleepController.recordActivity()
          if (resumedFromSleep) {
            send(ws, {
              type: GatewayServerEvent.VOICE_SLEEP,
              state: 'awake',
              wakeWord: config.wakeWord,
            })
            announcePendingPermissions()
            claimPendingNotifications()
            announcements.flush()
          }
        })
        .catch(error => {
          if (frontend !== createdFrontend) return
          connectionLogger.error('realtime.connect_failed', {
            provider: createdFrontend.provider.key,
            durationMs: Date.now() - connectStartedAt,
            error,
          })
          const classification = createdFrontend.provider.classifyError(error.message)
          if (classification === 'fatal') {
            realtimeBlockedError = error.message
            pendingAudio = []
          }
          // capacity_busy 是瞬时可恢复错误（如 s2s 单 session 槽尚未释放），
          // 由上层带退避重试，不向客户端报 unavailable 以避免唤醒流程闪烁。
          if (frontend === createdFrontend && classification !== 'capacity_busy') {
            send(ws, {
              type: GatewayServerEvent.VOICE_CONNECTION,
              state: 'unavailable',
              provider: createdFrontend.provider.key,
              message: error.message,
            })
          }
          throw error
        })
        .finally(() => {
          if (connectPromise === createdConnectPromise) connectPromise = null
        })
      connectPromise = createdConnectPromise
      return createdConnectPromise
    }

    const ensureFrontend = () => {
      if (realtimeBlockedError) {
        return Promise.reject(new Error(realtimeBlockedError))
      }
      if (frontend?.ready) return Promise.resolve()
      if (connectPromise) return connectPromise
      if (scheduledRealtimeReconnect) {
        return scheduledRealtimeReconnect.promise
      }
      return connectFrontendNow()
    }

    const enterSleep = () => {
      if (sleeping) return
      sleeping = true
      waking = false
      pendingAudio = []
      announcementWindow.reset()
      wakeDetector?.reset()
      cancelScheduledRealtimeReconnect()
      const staleFrontend = frontend
      frontend = null
      staleFrontend?.close()
      if (clientContext.states?.includes('sleeping')) {
        send(ws, {
          type: GatewayServerEvent.CLIENT_STATE,
          state: 'sleeping',
        })
      }
      send(ws, {
        type: GatewayServerEvent.VOICE_CONNECTION,
        state: 'sleeping',
        provider: sessionProvider,
      })
      send(ws, {
        type: GatewayServerEvent.VOICE_SLEEP,
        state: 'sleeping',
        wakeWord: config.wakeWord,
      })
    }

    const prepareSleepMode = () => {
      if (
        !config.wakeWordEnabled
        || nonVoiceClient
        // A suspended client is not capturing, so there is nothing for the wake
        // word to listen to and nothing that may wake this session.
        || inputSuspended
        || wakeDetectorPromise
      ) return
      if (wakeDetector) {
        sleepController.enable()
        if (sleeping) sleepController.holdSleeping()
        return
      }
      send(ws, {
        type: GatewayServerEvent.VOICE_SLEEP,
        state: 'preparing',
        wakeWord: config.wakeWord,
      })
      wakeDetectorPromise = createSherpaWakeWordDetector({
        modelRoot: config.wakeWordModelDirectory,
      }).then(detector => {
        wakeDetector = detector
        if (ws.readyState === WebSocket.OPEN) {
          sleepController.enable()
          send(ws, {
            type: GatewayServerEvent.VOICE_SLEEP,
            state: 'enabled',
            timeoutMs: config.sleepTimeoutMs,
            wakeWord: config.wakeWord,
          })
        }
      }).catch(error => {
        sleepController.disable()
        send(ws, {
          type: GatewayServerEvent.VOICE_SLEEP,
          state: 'disabled',
          message: `休眠功能未启用：${error.message}`,
        })
      }).finally(() => {
        wakeDetectorPromise = null
      })
    }

    // The desktop window and the realtime provider enter sleep as one explicit
    // state transition. Desktop decides when it is safe to hide because only
    // the client knows about visible work, permission prompts and playback.
    const requestExplicitSleep = () => {
      if (!config.wakeWordEnabled || nonVoiceClient) return false
      explicitSleepRequested = true
      inputEnabled = false
      pendingAudio = []
      prepareSleepMode()
      const finish = () => {
        if (!explicitSleepRequested || !wakeDetector) return false
        enterSleep()
        return sleeping
      }
      if (wakeDetector) return finish()
      wakeDetectorPromise?.then(finish).catch(() => {})
      return true
    }

    const WAKE_CONNECT_MAX_ATTEMPTS = 3
    const WAKE_CONNECT_RETRY_BACKOFF_MS = 350

    const attemptWakeConnect = attempt => {
      ensureFrontend().catch(error => {
        const provider =
          frontend?.provider ?? realtimeProviderRegistry.resolve(sessionProvider)
        const classification =
          provider.classifyError?.(error.message) ?? 'other'
        if (
          classification === 'capacity_busy'
          && attempt < WAKE_CONNECT_MAX_ATTEMPTS
        ) {
          connectionLogger.info('realtime.wake_connect_retry', {
            attempt: attempt + 1,
            provider: provider.key,
            error: error.message,
          })
          // 先放弃失败的前端，避免其异步 onClose 干扰下一次重试。
          const failedFrontend = frontend
          frontend = null
          failedFrontend?.close()
          setTimeout(
            () => attemptWakeConnect(attempt + 1),
            WAKE_CONNECT_RETRY_BACKOFF_MS,
          )
          return
        }
        waking = false
        sleeping = true
        sleepController.holdSleeping()
        cancelScheduledRealtimeReconnect()
        const failedFrontend = frontend
        frontend = null
        failedFrontend?.close()
        send(ws, {
          type: GatewayServerEvent.VOICE_CONNECTION,
          state: 'sleeping',
          provider: sessionProvider,
          message: error.message,
        })
      })
    }

    const wakeFromSleep = () => {
      if (!sleeping || waking) return
      explicitSleepRequested = false
      sleeping = false
      waking = true
      sleepController.wake()
      send(ws, {
        type: GatewayServerEvent.VOICE_SLEEP,
        state: 'detected',
        wakeWord: config.wakeWord,
      })
      attemptWakeConnect(0)
    }

    const submitInputMessage = event => {
      let parts
      try {
        parts = withAttachmentAnchors(normalizeInputParts(
          event.parts,
          { fallbackText: event.text },
        ))
      } catch (error) {
        send(ws, { type: GatewayServerEvent.ERROR, message: error.message })
        return
      }
      const inputTurnId = `text_${randomUUID().replaceAll('-', '')}`
      parts = inputAssets.registerParts({
        ownerId,
        sessionId,
        turnId: inputTurnId,
        parts,
      })
      const text = inputText(parts)
      const display = displayInputText(parts)
      const supersededVoiceTurn = userSpeaking ? currentTurn() : null
      userSpeaking = false
      turnGeneration = ++turnSequence
      turnId = inputTurnId
      manualInputGeneration = turnGeneration
      inputTurns.invalidateBeforeGeneration(turnGeneration)
      const inputContext = currentTurn()
      commitTurn(inputContext)
      clearResponseCandidate()
      // Text and attachment submissions are first-class user turns. They must
      // close any result announcement still occupying the previous turn and
      // block a newly completed task from speaking over the response now being
      // generated, just like input_audio_buffer.speech_started does for voice.
      announcementWindow.beginTurn(inputTurnId)
      announcementWindow.endSpeech()
      announcements.dismissActive()
      send(ws, {
        type: GatewayServerEvent.PLAYBACK_CLEAR,
        reason: 'user_interruption',
      })
      if (supersededVoiceTurn?.turnId) {
        send(ws, {
          type: GatewayServerEvent.TRANSCRIPT_DISCARD,
          role: 'user',
          turnId: supersededVoiceTurn.turnId,
          reason: 'superseded_by_manual_input',
        })
      }
      send(ws, { type: GatewayServerEvent.TURN_STARTED, turnId: inputTurnId })
      send(ws, {
        type: GatewayServerEvent.VOICE_STATE,
        state: 'processing',
        turnId: inputTurnId,
        origin: 'model',
      })
      frontend?.cancel()
      transcripts.record(inputTurnId, text || display)
      transcripts.recordParts(inputTurnId, inputFileParts(parts))
      conversationSync.record({
        ownerId,
        sessionId,
        id: `voice:user:${inputTurnId}`,
        role: 'user',
        content: display,
        source: 'text-user',
        turnId: inputTurnId,
        inputs: inputAssets.metadataForParts(parts),
      })
      send(ws, {
        type: GatewayServerEvent.TRANSCRIPT_FINAL,
        role: 'user',
        content: display,
        turnId: inputTurnId,
      })
      ensureFrontend()
        .then(() => frontend.sendUserInput(
          parts,
          inputContext,
        ))
        .catch(error => {
          if (manualInputGeneration === inputContext.turnGeneration) {
            manualInputGeneration = null
          }
          reportFrontendError(error)
        })
    }

    const acceptSleepingAudio = audio => {
      try {
        const sampleRate = realtimeProviderRegistry.resolve(sessionProvider)
          .inputSampleRate
        if (wakeDetector?.accept(audio, sampleRate)) wakeFromSleep()
      } catch (error) {
        sleeping = false
        waking = false
        sleepController.disable()
        send(ws, {
          type: GatewayServerEvent.VOICE_SLEEP,
          state: 'disabled',
          message: `唤醒词检测已停止：${error.message}`,
        })
        ensureFrontend().catch(connectionError => send(ws, {
          type: 'error',
          message: connectionError.message,
        }))
      }
    }

    sleepController = new SleepController({
      timeoutMs: config.sleepTimeoutMs,
      canSleep: () => (
        (inputEnabled || config.wakeWordEnabled)
        && activeVoiceClients.isActive(ownerId, voiceClient)
        && frontend?.ready
        && !userSpeaking
        && !announcementWindow.isBlocked()
        && !connectPromise
        && !waking
      ),
      onSleep: enterSleep,
    })

    send(ws, { type: GatewayServerEvent.VOICE_STATE, state: 'idle' })
    // A client connecting mid-suspension has to learn about it before it opens
    // a microphone.
    if (inputSuspended) {
      const status = inputArbitration.status()
      send(ws, {
        type: GatewayServerEvent.INPUT_SUSPEND,
        owner: status.owner,
        reason: status.reason,
        expiresAt: status.expiresAt,
      })
    }
    ws.on('message', raw => {
      let event
      try {
        event = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (!isGatewayClientEvent(event)) return
      if (event.type === GatewayClientEvent.CONNECT) {
        descriptor = clientDescriptor(event)
        voiceClient.descriptor = descriptor
        connectionLogger.info('voice_client.configured', {
          clientType: descriptor.type,
          clientLabel: descriptor.label,
          requestedProvider: event.provider || sessionProvider,
          inputEnabled: event.inputEnabled === true,
          outputEnabled: event.outputEnabled === true,
          textOnly: event.textOnly === true,
        })
        nonVoiceClient = event.textOnly === true
        // The client may pick a realtime front end per session. An unknown
        // name is reported instead of silently falling back, so a typo does
        // not look like a working session on the wrong provider.
        if (event.provider && event.provider !== sessionProvider) {
          try {
            const requested = realtimeProviderRegistry.resolve(event.provider)
            sessionProvider = requested.key
            realtimeBlockedError = ''
            const staleFrontend = frontend
            frontend = null
            cancelScheduledRealtimeReconnect()
            connectPromise = null
            staleFrontend?.close()
          } catch (error) {
            send(ws, { type: 'error', message: error.message })
            return
          }
        }
        const capabilities = clientVoiceCapabilities({
          voiceEnabled: event.voiceEnabled,
          inputEnabled: event.inputEnabled,
          outputEnabled: event.outputEnabled,
          textOnly: nonVoiceClient,
        })
        if (capabilities.participatesInVoiceArbitration) {
          activateVoiceClient({
            takeover: event.takeover === true,
            enableInput: capabilities.inputEnabled,
            enableOutput: capabilities.outputEnabled,
          })
        } else {
          releaseVoiceClient()
          inputEnabled = capabilities.inputEnabled
          outputEnabled = capabilities.outputEnabled
          broadcastVoiceOwnership(ownerId)
        }
        clientContext = normalizeClientContext({
          timeZone: event.timeZone,
          locale: event.locale,
          workingDirectory: event.workingDirectory,
        })
        clientContext.states = (
          descriptor.type === 'desktop'
          && Array.isArray(event.clientStates)
          && event.clientStates.includes('sleeping')
        ) ? ['sleeping'] : []
        clientContext.inputCapabilities = (
          event.inputCapabilities
          && typeof event.inputCapabilities === 'object'
        ) ? {
            text: event.inputCapabilities.text === true,
            audio: event.inputCapabilities.audio === true,
            image: event.inputCapabilities.image === true,
            resource: event.inputCapabilities.resource === true,
          }
          : null
        // A desktop that advertises the sleeping state owns its inactivity
        // policy. Keep Gateway's legacy automatic timer only for clients that
        // cannot request an explicit synchronized sleep transition.
        sleepController.setTimeoutMs(
          clientContext.states.includes('sleeping')
            ? 0
            : config.sleepTimeoutMs,
        )
        frontend?.updateAgentContext({
          client: clientContext,
        })
        if (sleeping) {
          sleeping = false
          waking = true
          sleepController.wake()
        }
        prepareSleepMode()
        if (event.wakeWordOnly === true) {
          requestExplicitSleep()
        } else if (inputEnabled || outputEnabled) {
          ensureFrontend().catch(reportFrontendError)
        }
      } else if (event.type === GatewayClientEvent.UNMUTE) {
        explicitSleepRequested = false
        if (nonVoiceClient) {
          inputEnabled = false
          outputEnabled = true
          broadcastVoiceOwnership(ownerId)
        } else {
          activateVoiceClient({ takeover: event.takeover === true })
        }
        ensureFrontend()
          .then(() => {
            prepareSleepMode()
            announcePendingPermissions()
            claimPendingNotifications()
            announcements.flush()
          })
          .catch(reportFrontendError)
      } else if (event.type === GatewayClientEvent.INPUT_UNMUTE) {
        explicitSleepRequested = false
        if (nonVoiceClient) return
        if (activeVoiceClients.isActive(ownerId, voiceClient)) {
          inputEnabled = true
          outputEnabled = true
          broadcastVoiceOwnership(ownerId)
        } else {
          activateVoiceClient({ takeover: event.takeover === true })
        }
        if (sleeping) {
          prepareSleepMode()
          return
        }
        ensureFrontend()
          .then(() => {
            prepareSleepMode()
            announcePendingPermissions()
            claimPendingNotifications()
            announcements.flush()
          })
          .catch(reportFrontendError)
      } else if (event.type === GatewayClientEvent.AUDIO_APPEND) {
        if (sleeping) {
          if (wakeDetector) acceptSleepingAudio(event.audio)
          return
        }
        if (
          !inputEnabled
          // Defence in depth: a client that has not yet acted on the suspension
          // must not be able to feed audio through it.
          || inputSuspended
          || !activeVoiceClients.isActive(ownerId, voiceClient)
        ) {
          return
        }
        if (frontend?.ready) frontend.appendAudio(event.audio)
        else {
          pendingAudio.push(event.audio)
          if (pendingAudio.length > MAX_PENDING_AUDIO_CHUNKS) {
            pendingAudio.splice(0, pendingAudio.length - MAX_PENDING_AUDIO_CHUNKS)
          }
          // CONNECT/onClose owns connection establishment and retries. Audio
          // arriving during a close/backoff window is buffered, but must never
          // bypass that window and create a second Realtime connection.
          if (!connectPromise && !scheduledRealtimeReconnect) {
            ensureFrontend().catch(reportFrontendError)
          }
        }
      } else if (
        event.type === GatewayClientEvent.TEXT_MESSAGE
        || event.type === GatewayClientEvent.INPUT_MESSAGE
      ) {
        if (sleeping || waking) {
          send(ws, {
            type: 'error',
            message: `已休眠，请先说“${config.wakeWord}”唤醒。`,
          })
          return
        }
        sleepController.recordActivity()
        submitInputMessage(event)
      } else if (event.type === GatewayClientEvent.INTERRUPT) {
        sleepController.recordActivity()
        turnGeneration = ++turnSequence
        committedTurnGeneration = turnGeneration
        announcementWindow.interrupt()
        announcements.dismissActive()
        frontend?.cancel()
      } else if (event.type === GatewayClientEvent.PLAYBACK_STARTED) {
        const id = String(event.responseId || '')
        if (acceptsPlaybackReceipt({
          outputEnabled,
          active: activeVoiceClients.isActive(ownerId, voiceClient),
          responseKnown: responseContexts.has(id),
        })) startPlayback(id)
      } else if (event.type === GatewayClientEvent.PLAYBACK_ENDED) {
        const id = String(event.responseId || '')
        if (acceptsPlaybackReceipt({
          outputEnabled,
          active: activeVoiceClients.isActive(ownerId, voiceClient),
          responseKnown: responseContexts.has(id),
        })) finishPlayback(id)
      } else if (event.type === GatewayClientEvent.PLAYBACK_CANCELLED) {
        const id = String(event.responseId || '')
        if (acceptsPlaybackReceipt({
          outputEnabled,
          active: activeVoiceClients.isActive(ownerId, voiceClient),
          responseKnown: responseContexts.has(id),
        })) {
          cancelQueuedPlayback(id, {
            reason: String(event.reason || ''),
          })
        }
      } else if (event.type === GatewayClientEvent.MUTE) {
        explicitSleepRequested = false
        releaseVoiceClient()
        sleeping = false
        waking = false
        sleepController?.disable()
        turnGeneration = ++turnSequence
        committedTurnGeneration = turnGeneration
        pendingAudio = []
        announcementWindow.reset()
        cancelScheduledRealtimeReconnect()
        frontend?.close()
      } else if (event.type === GatewayClientEvent.INPUT_MUTE) {
        inputEnabled = false
        pendingAudio = []
      } else if (event.type === GatewayClientEvent.SLEEP) {
        requestExplicitSleep()
      } else if (event.type === GatewayClientEvent.WAKE) {
        // 桌面快捷键/托盘唤起只恢复窗口可见性，休眠中的前台连接靠这个事件
        // 恢复，复用唤醒词检测之后同一套重连与退避路径。
        explicitSleepRequested = false
        if (sleeping) wakeFromSleep()
        else sleepController.recordActivity()
      } else if (event.type === GatewayClientEvent.INPUT_SUSPEND_ACK) {
        connectionLogger.debug('input.suspend_acknowledged', {
          clientType: descriptor.type,
          owner: String(event.owner || '') || null,
        })
      }
    })

    ws.on('close', () => {
      connectionLogger.info('voice_client.disconnected', {
        clientType: descriptor.type,
      })
      releaseVoiceClient()
      const connections = voiceConnections.get(ownerId)
      connections?.delete(voiceClient)
      if (!connections?.size) voiceConnections.delete(ownerId)
      unsubscribeTasks()
      clearResponseCandidate()
      turnGeneration = ++turnSequence
      committedTurnGeneration = turnGeneration
      transcripts.close()
      announcementWindow.reset()
      playbackTurns.clear()
      inputTurns.clear()
      announcements.close()
      clearTimeout(permissionRetryTimer)
      permissionRetryTimer = null
      cancelScheduledRealtimeReconnect()
      sleepController?.close()
      frontend?.close()
      // Invisible memory: distil durable personal facts from this session in
      // the background. All gating (debounce, minimum turns, disabled state)
      // lives inside the extractor; it never blocks or breaks the close path,
      // and even a misbehaving extractor must not disturb the disconnect.
      try {
        memoryExtractor?.maybeRun({ ownerId, sessionId })
      } catch (error) {
        connectionLogger.warn('memory.extract_hook_failed', {
          error: String(error?.message || error),
        })
      }
    })
  })

  return {
    close() {
      for (const client of wss.clients) client.close()
      return new Promise(resolveClose => {
        wss.close(() => resolveClose())
      })
    },
    status() {
      const byType = { desktop: 0, cli: 0, web: 0 }
      const realtime = {
        connected: 0,
        connecting: 0,
        disconnected: 0,
        unavailable: 0,
        sleeping: 0,
        waking: 0,
        byProvider: {},
      }
      let connected = 0
      for (const clients of voiceConnections.values()) {
        for (const client of clients) {
          connected += 1
          const type = client.descriptor?.type || 'web'
          byType[type] = (byType[type] || 0) + 1
          const status = client.realtimeStatus?.()
          if (!status) continue
          realtime[status.state] = (realtime[status.state] || 0) + 1
          if (!realtime.byProvider[status.provider]) {
            realtime.byProvider[status.provider] = {
              connected: 0,
              connecting: 0,
              disconnected: 0,
              unavailable: 0,
              sleeping: 0,
              waking: 0,
            }
          }
          const provider = realtime.byProvider[status.provider]
          provider[status.state] = (provider[status.state] || 0) + 1
          if (status.error) provider.error = status.error
        }
      }
      return {
        connected,
        activeOwners: activeVoiceClients.size,
        byType,
        realtime,
      }
    },
  }
}
