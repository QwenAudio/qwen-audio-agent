import { WebSocket, WebSocketServer } from 'ws'
import { randomUUID } from 'node:crypto'
import {
  GatewayClientEvent,
  GatewayServerEvent,
  isGatewayClientEvent,
} from '../../../shared/realtime-events.mjs'
import { AnnouncementWindow } from './announcement/announcement-window.mjs'
import {
  createTaskAnnouncementRuntime,
  resolveTaskAnnouncementRuntime,
} from './announcement/task-announcement-runtime.mjs'
import { config } from '../core/config.mjs'
import { logger } from '../core/logger.mjs'
import { conversationSync } from '../conversation/conversation-sync.mjs'
import { InputAssetRegistry } from './input-asset-registry.mjs'
import { normalizeClientContext } from '../conversation/frontend-agent-context.mjs'
import {
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
import { TurnCitations } from './turn-citations.mjs'
import { RealtimeInputRuntime } from './realtime-input-runtime.mjs'
import {
  acceptsPlaybackReceipt,
  confirmsTaskNotificationOnPlaybackStart,
  RealtimePresentationRuntime,
} from './realtime-presentation-runtime.mjs'
import { RealtimeTurnState } from './realtime-turn-state.mjs'
import {
  ActiveVoiceClients,
  clientVoiceCapabilities,
} from './active-voice-clients.mjs'
import { RealtimeProviderSession } from './realtime-provider-session.mjs'
import { SleepController } from './sleep-controller.mjs'
import { createSherpaWakeWordDetector } from './wake-word/sherpa-detector.mjs'
import {
  isResponseActivityEvent,
  realtimeResponseId,
} from './response-lifecycle.mjs'
import {
  frontendSourceToolCapabilities,
  frontendSourceToolDefinitions,
} from '../frontend/tools/frontend-tool-source.mjs'
import { FRONTEND_RECALL_CAPABILITY } from './frontend-tools.mjs'

const MAX_PENDING_AUDIO_CHUNKS = 30
const RESPONSE_START_WATCHDOG_MS = 12000
const PERMISSION_RESPONSE_GRACE_MS = 800
const RESPONSE_CONTEXT_CLEANUP_MS = 30000
const REALTIME_STABLE_CONNECTION_MS = 10000

function gatewayTurnId() {
  return `gateway_${randomUUID().replaceAll('-', '')}`
}

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

export {
  acceptsPlaybackReceipt,
  confirmsTaskNotificationOnPlaybackStart,
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
  preferencePromoter = null,
  profileObserver = null,
  sessionDigests = null,
  sessionSummariser = null,
  notesStore,
  backendRuntime,
  backendAvailability = null,
  respondAuthorization,
  permissionPolicy,
  inputAssets = new InputAssetRegistry(),
  inputArbitration = null,
  realtimeProviderRegistry = defaultRealtimeProviderRegistry,
  defaultRealtimeProvider = config.audioProvider,
  frontendRetrieval = null,
  frontendKnowledge = null,
  frontendToolSources = [],
  taskAnnouncementFactory = createTaskAnnouncementRuntime,
}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 20 * 1024 * 1024 })
  const activeVoiceClients = new ActiveVoiceClients()
  const voiceConnections = new Map()
  const frontendToolSourcesReady = Promise.all(
    frontendToolSources.map(source => source.initialize()),
  ).catch(error => {
    logger.warn('frontend_tools.initialization_failed', {
      error: error.message,
    })
  })

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
    let inputEnabled = false
    let outputEnabled = false
    // Set only by host arbitration. Unlike inputEnabled (which the client
    // declares about itself) this means the client has been ordered to stop
    // capturing, so nothing here may re-enable audio on its own.
    let inputSuspended = inputArbitration?.suspended === true
    let nonVoiceClient = false
    let descriptor = clientDescriptor()
    let responseTurnCandidate = null
    let responseStartWatchdog = null
    let permissionResponseTimer = null
    let sleeping = false
    let waking = false
    let explicitSleepRequested = false
    let wakeDetector = null
    let wakeDetectorPromise = null
    let sleepController
    const announcementWindow = new AnnouncementWindow()
    const notificationClaimantId = `voice_${randomUUID()}`
    let clientContext = normalizeClientContext()
    const turns = new RealtimeTurnState()
    const transcripts = new TurnTranscripts()
    const turnCitations = new TurnCitations()
    const announcedPermissions = new Set()
    let permissionRetryTimer = null
    let realtimeSession
    const activeSessionTasks = () => taskManager.list({
      ownerId,
      sessionId,
      active: true,
    })
    const getAgentContext = () => ({
      client: clientContext,
      frontend: {
        capabilities: [...new Set([
          ...(frontendRetrieval?.capabilities?.() || []),
          ...(frontendKnowledge?.capabilities?.() || []),
          ...frontendSourceToolCapabilities(frontendToolSources),
          // 会话摘要池与资料库都没启用时不暴露 recall —— 池子永远是空的，
          // 暴露它只会让模型白调一次。会话摘要本身绝不注入 instructions：
          // 它每场都在变，会让 prompt 前缀每场都变。
          ...(sessionDigests ? [FRONTEND_RECALL_CAPABILITY] : []),
        ])],
        tools: frontendSourceToolDefinitions(frontendToolSources),
      },
      memories: memoryService?.list(ownerId, { limit: 64 }) || [],
      recentMessages: conversationSync.frontendContext({ ownerId, sessionId }),
    })
    const schedulePermissionRetry = () => {
      if (permissionRetryTimer || !outputEnabled || !realtimeSession?.ready) return
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
        || !realtimeSession?.ready
        || permission?.status !== 'pending'
        || announcedPermissions.has(permission.id)
      ) return
      if (turns.userSpeaking || announcementWindow.isBlocked()) {
        schedulePermissionRetry()
        return
      }
      announcedPermissions.add(permission.id)
      realtimeSession.frontend.injectPermission(permission, {
        // A permission prompt is a new model input and response. taskId keeps
        // it correlated with the work without reusing the user's old turn.
        turnId: gatewayTurnId(),
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
    const taskAnnouncements = resolveTaskAnnouncementRuntime(
      taskAnnouncementFactory,
      {
        resultOptions: {
          getFrontend: () => realtimeSession?.frontend,
          isDeliveryBlocked: () => (
            sleeping
            || waking
            || !outputEnabled
            || announcementWindow.isBlocked()
          ),
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
        },
        progressOptions: {
          getFrontend: () => realtimeSession?.frontend,
          isDeliveryBlocked: () => (
            sleeping
            || waking
            || !outputEnabled
            || !realtimeSession?.ready
            || turns.userSpeaking
            || announcementWindow.isBlocked()
          ),
          isTaskActive: taskId => activeSessionTasks().some(task => (
            task.id === taskId
          )),
          intervalMs: 60_000,
          quietMs: config.announcementQuietMs,
          onError: error => connectionLogger.warn('progress.injection_failed', {
            error: error.message,
          }),
        },
      },
    )
    const announcements = taskAnnouncements.results
    const progressAnnouncements = taskAnnouncements.progress
    const reportFrontendError = error => {
      if (error?.realtimeConnectionReported) return
      if (error) error.realtimeConnectionReported = true
      send(ws, { type: GatewayServerEvent.ERROR, message: error?.message || String(error) })
    }
    realtimeSession = new RealtimeProviderSession({
      providerRegistry: realtimeProviderRegistry,
      defaultProvider: defaultRealtimeProvider,
      getAgentContext,
      shouldReconnect: () => inputEnabled || outputEnabled,
      onEvent: event => handleEvent(event),
      onDiagnostic: diagnostic => {
        const { event, ...fields } = diagnostic
        connectionLogger.warn(event, fields)
      },
      onConnected: () => announcePendingPermissions(),
      onReady: createdFrontend => {
        const resumedFromSleep = waking
        waking = false
        if (outputEnabled) claimPendingNotifications()
        send(ws, {
          type: GatewayServerEvent.VOICE_READY,
          inputSampleRate: createdFrontend.provider.inputSampleRate,
          provider: createdFrontend.provider.key,
          providerLabel: createdFrontend.provider.label,
        })
        prepareSleepMode()
        sleepController.recordActivity()
        progressAnnouncements.flush()
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
      },
      onDisconnected: () => send(ws, {
        type: GatewayServerEvent.VOICE_STATE,
        state: 'idle',
      }),
      onReconnected: () => {
        announcements.flush()
        progressAnnouncements.flush()
      },
      onConnectionState: event => send(ws, {
        type: GatewayServerEvent.VOICE_CONNECTION,
        ...event,
      }),
      onError: reportFrontendError,
      onReconnectError: error => send(ws, {
        type: GatewayServerEvent.ERROR,
        message: `实时语音连接恢复失败：${error.message}`,
      }),
      logger: connectionLogger,
      maxPendingAudioChunks: MAX_PENDING_AUDIO_CHUNKS,
      stableConnectionMs: REALTIME_STABLE_CONNECTION_MS,
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
          realtimeSession.clearPendingAudio()
          sleepController?.disable()
          realtimeSession.cancelResponse()
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
      realtimeStatus: () => realtimeSession.status({
        sleeping,
        waking,
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
        announcementWindow.reset()
        announcements.pause()
        progressAnnouncements.clear()
        realtimeSession.close({ notifyDisconnected: true })
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
      progressAnnouncements.clear()
      if (activeVoiceClients.release(ownerId, voiceClient)) {
        broadcastVoiceOwnership(ownerId)
      }
    }
    const toolCalls = new ToolCallHandler({
      taskManager,
      ownerId,
      sessionId,
      transcripts,
      getFrontend: () => realtimeSession.frontend,
      getTurnId: () => turns.committedTurnId,
      getTurnGeneration: () => turns.committedTurnGeneration,
      memoryService,
      notesStore,
      getClientContext: () => clientContext,
      getConversationContext: () => conversationSync.frontendContext({
        ownerId,
        sessionId,
      }),
      // 记忆写入只刷新缓存，不重发 session.update：改 instructions 等于改 prompt
      // 前缀，会让整场会话的前缀缓存失效，而用户刚说过的内容本来就在上下文里，
      // 不必靠 instructions 再讲一遍。新值在下一个新会话生效。
      onMemoryChanged: () => realtimeSession.updateAgentContext({
        memories: memoryService?.list(ownerId, { limit: 64 }) || [],
      }, { refreshSession: false }),
      backendRuntime,
      backendAvailability,
      respondAuthorization,
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
      frontendRetrieval,
      frontendKnowledge,
      frontendToolSources,
      turnCitations,
      sessionDigests,
    })
    const clearResponseCandidate = () => {
      clearTimeout(responseStartWatchdog)
      clearTimeout(permissionResponseTimer)
      responseStartWatchdog = null
      permissionResponseTimer = null
      responseTurnCandidate = null
    }

    const ensurePermissionResponseFor = context => {
      clearTimeout(permissionResponseTimer)
      const hasPendingPermission = () => activeSessionTasks().some(task => (
        task.authorization?.status === 'pending'
      ))
      if (!hasPendingPermission()) return
      permissionResponseTimer = setTimeout(() => {
        permissionResponseTimer = null
        realtimeSession.frontend?.ensureResponse({
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
        realtimeSession.reconnect().catch(error => send(ws, {
          type: 'error',
          message: error.message,
        }))
      }, realtimeSession.frontend?.provider.responseStartTimeoutMs
        ?? RESPONSE_START_WATCHDOG_MS)
      responseStartWatchdog.unref?.()
    }

    const inputs = new RealtimeInputRuntime({
      ownerId,
      sessionId,
      turns,
      transcripts,
      inputAssets,
      conversationSync,
      announcementWindow,
      announcements,
      send: event => send(ws, event),
      getFrontend: () => realtimeSession.frontend,
      ensureFrontend: () => realtimeSession.ensure(),
      clearResponseCandidate,
      expectResponseFor,
      shouldEnsurePermissionResponse: context => responseTurnCandidate === context,
      ensurePermissionResponseFor,
      reportFrontendError,
    })

    const presentationRuntime = new RealtimePresentationRuntime({
      ownerId,
      sessionId,
      turns,
      conversationSync,
      announcementWindow,
      announcements,
      toolCalls,
      send: event => send(ws, event),
      getFrontend: () => realtimeSession.frontend,
      getOutputEnabled: () => outputEnabled,
      getNonVoiceClient: () => nonVoiceClient,
      getResponseTurnCandidate: () => responseTurnCandidate,
      clearResponseCandidate,
      announcementQuietMs: config.announcementQuietMs,
      responseContextCleanupMs: RESPONSE_CONTEXT_CLEANUP_MS,
      turnCitations,
    })

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

    const claimPendingNotifications = (
      taskIds,
      { includeOtherSessions = !taskIds?.length } = {},
    ) => {
      if (!outputEnabled || !realtimeSession.ready) return
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
      if (
        event.type === TaskDomainEvent.UPDATED
        && event.message
        && outputEnabled
        && !sleeping
        && !waking
      ) {
        progressAnnouncements.offer({
          taskId: task.id,
          startedAt: task.startedAt,
          message: event.message,
        })
      }
      if (event.type === TaskDomainEvent.PERMISSION_REQUESTED) {
        if (sleeping) {
          wakeFromSleep()
          return
        }
        announcePermission(task)
      }
      if (event.type === TaskDomainEvent.PERMISSION_RESOLVED) {
        const authorizationId = event.permission?.id
        // A permission confirmation already tells the user that work resumes.
        // Drop progress queued before the decision so it cannot immediately
        // repeat the same “still working” information after that confirmation.
        progressAnnouncements.remove(task.id)
        if (authorizationId) {
          // 已进入对话的权限询问被其它通道（如 WebUI 按钮）处理后，把结果
          // 静默回注模型上下文：避免模型不知情而重复追问，或把用户随后的
          // 口头确认误报为“请求已失效”。
          if (announcedPermissions.has(authorizationId) && realtimeSession.ready) {
            realtimeSession.frontend.appendUserInputContext([{
              type: 'text',
              text: '（系统提示：刚才的后台权限请求已处理完毕，任务继续执行；'
                + '无需再询问或回应该请求。）',
            }]).catch(() => {})
          }
          announcedPermissions.delete(authorizationId)
          realtimeSession.frontend?.cancelResponses((context, origin) => (
            origin === 'permission'
            && context?.authorizationId === authorizationId
          ))
          presentationRuntime.cancelPermission(authorizationId)
        }
      }
      if ([
        TaskDomainEvent.COMPLETED,
        TaskDomainEvent.FAILED,
        TaskDomainEvent.CANCELLED,
      ].includes(event.type)) {
        progressAnnouncements.remove(task.id)
      }
      if ([
        TaskDomainEvent.COMPLETED,
        TaskDomainEvent.FAILED,
      ].includes(event.type)) {
        recordResult(task)
        claimPendingNotifications([task.id])
      }
    })

    const handleEvent = event => {
      if (isSleepActivityEvent(event)) sleepController?.recordActivity()
      if (isResponseActivityEvent(event)) presentationRuntime.begin(event)
      if (inputs.handleProviderEvent(event)) return
      if (event.type === 'response.function_call_arguments.done') {
        const id = realtimeResponseId(event)
        const callContext = presentationRuntime.get(id)
          || { turnId: '', turnGeneration: -1 }
        logger.info('realtime.tool_call.received', {
          responseId: id,
          callId: event.call_id || event.item?.call_id || '',
          toolName: event.name || event.item?.name || '',
          turnId: callContext.turnId || '',
        })
        presentationRuntime.markFunctionCall(id)
        toolCalls.handle(event, { ...callContext, responseId: id }).catch(error => {
          send(ws, { type: 'error', message: error.message })
        })
      } else if (presentationRuntime.handle(event)) {
        return
      } else if (event.type === 'error') {
        // A response refused by a busy single-slot provider is retried by the
        // frontend transparently; nothing user-facing happened.
        if (event.__voiceRetried) return
        const errorMessage = realtimeEventErrorMessage(event)
        const providerError = realtimeSession.classifyError(errorMessage)
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
            provider: realtimeSession.providerKey,
            classification: providerError,
            errorMessage,
          })
          realtimeSession.block(errorMessage)
          send(ws, {
            type: GatewayServerEvent.VOICE_CONNECTION,
            state: 'unavailable',
            provider: realtimeSession.providerKey,
            message: errorMessage,
          })
        }
        presentationRuntime.failResponse(event)
        // A provider may close an inactive response scope while a delegated
        // backend task is still running. The task remains healthy, and any
        // pending announcement has already returned to the retry queue, so this
        // provider housekeeping event is not user-facing.
        if (!recoverableInactivity && providerError !== 'fatal') {
          send(ws, { type: 'error', message: errorMessage })
        }
      }
    }

    const enterSleep = () => {
      if (sleeping) return
      sleeping = true
      waking = false
      announcementWindow.reset()
      progressAnnouncements.clear()
      wakeDetector?.reset()
      realtimeSession.close()
      if (clientContext.states?.includes('sleeping')) {
        send(ws, {
          type: GatewayServerEvent.CLIENT_STATE,
          state: 'sleeping',
        })
      }
      send(ws, {
        type: GatewayServerEvent.VOICE_CONNECTION,
        state: 'sleeping',
        provider: realtimeSession.providerKey,
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
      realtimeSession.clearPendingAudio()
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
      realtimeSession.ensure().catch(error => {
        const provider = realtimeSession.provider()
        const classification = realtimeSession.classifyError(error.message)
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
          realtimeSession.detach({ clearAudio: false })
          setTimeout(
            () => attemptWakeConnect(attempt + 1),
            WAKE_CONNECT_RETRY_BACKOFF_MS,
          )
          return
        }
        waking = false
        sleeping = true
        sleepController.holdSleeping()
        realtimeSession.close()
        send(ws, {
          type: GatewayServerEvent.VOICE_CONNECTION,
          state: 'sleeping',
          provider: realtimeSession.providerKey,
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

    const acceptSleepingAudio = audio => {
      try {
        const sampleRate = realtimeSession.provider().inputSampleRate
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
        realtimeSession.ensure().catch(connectionError => send(ws, {
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
        && realtimeSession.ready
        && !turns.userSpeaking
        && !announcementWindow.isBlocked()
        && !realtimeSession.connecting
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
          requestedProvider: event.provider || realtimeSession.providerKey,
          inputEnabled: event.inputEnabled === true,
          outputEnabled: event.outputEnabled === true,
          textOnly: event.textOnly === true,
        })
        nonVoiceClient = event.textOnly === true
        // The client may pick a realtime front end per session. An unknown
        // name is reported instead of silently falling back, so a typo does
        // not look like a working session on the wrong provider.
        if (event.provider && event.provider !== realtimeSession.providerKey) {
          try {
            realtimeSession.switchProvider(event.provider)
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
        frontendToolSourcesReady.then(() => {
          if (ws.readyState !== WebSocket.OPEN) return
          realtimeSession.updateAgentContext(getAgentContext())
          if (sleeping) {
            sleeping = false
            waking = true
            sleepController.wake()
          }
          prepareSleepMode()
          if (event.wakeWordOnly === true) {
            requestExplicitSleep()
          } else if (inputEnabled || outputEnabled) {
            realtimeSession.ensure().catch(reportFrontendError)
          }
        }).catch(reportFrontendError)
      } else if (event.type === GatewayClientEvent.UNMUTE) {
        explicitSleepRequested = false
        if (nonVoiceClient) {
          inputEnabled = false
          outputEnabled = true
          broadcastVoiceOwnership(ownerId)
        } else {
          activateVoiceClient({ takeover: event.takeover === true })
        }
        realtimeSession.ensure()
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
        realtimeSession.ensure()
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
        realtimeSession.appendAudio(event.audio)
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
        inputs.submit(event)
      } else if (event.type === GatewayClientEvent.INTERRUPT) {
        sleepController.recordActivity()
        turns.advanceBoundary()
        announcementWindow.interrupt()
        announcements.dismissActive()
        realtimeSession.cancelResponse()
      } else if (event.type === GatewayClientEvent.PLAYBACK_STARTED) {
        const id = String(event.responseId || '')
        if (acceptsPlaybackReceipt({
          outputEnabled,
          active: activeVoiceClients.isActive(ownerId, voiceClient),
          responseKnown: presentationRuntime.has(id),
        })) presentationRuntime.startPlayback(id)
      } else if (event.type === GatewayClientEvent.PLAYBACK_ENDED) {
        const id = String(event.responseId || '')
        if (acceptsPlaybackReceipt({
          outputEnabled,
          active: activeVoiceClients.isActive(ownerId, voiceClient),
          responseKnown: presentationRuntime.has(id),
        })) presentationRuntime.finishPlayback(id)
      } else if (event.type === GatewayClientEvent.PLAYBACK_CANCELLED) {
        const id = String(event.responseId || '')
        if (acceptsPlaybackReceipt({
          outputEnabled,
          active: activeVoiceClients.isActive(ownerId, voiceClient),
          responseKnown: presentationRuntime.has(id),
        })) {
          presentationRuntime.cancelPlayback(id, {
            reason: String(event.reason || ''),
          })
        }
      } else if (event.type === GatewayClientEvent.MUTE) {
        explicitSleepRequested = false
        releaseVoiceClient()
        sleeping = false
        waking = false
        sleepController?.disable()
        turns.advanceBoundary()
        announcementWindow.reset()
        progressAnnouncements.clear()
        realtimeSession.close({ notifyDisconnected: true })
      } else if (event.type === GatewayClientEvent.INPUT_MUTE) {
        inputEnabled = false
        realtimeSession.clearPendingAudio()
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
      turns.close()
      transcripts.close()
      turnCitations.clear()
      announcementWindow.reset()
      presentationRuntime.clear()
      announcements.close()
      progressAnnouncements.close()
      clearTimeout(permissionRetryTimer)
      permissionRetryTimer = null
      sleepController?.close()
      realtimeSession.close()
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
      // 画像观察 → 晋升扫描。观察器要调模型所以是异步的，晋升必须排在它之后：
      // 否则本场刚攒到的确认要等下一场会话结束才被扫到，白等一轮。观察器未启用
      // 或未达门槛时走同步分支，保持原有行为。晋升本身是纯本地计算、无模型调用，
      // 写入只在下一个新会话生效，不触碰当前会话的 instructions（保护前缀缓存）。
      // promoter.run() 是 async 的（写入要等 MemoryProvider 落地才销账），所以
      // 同步 try/catch 抓不到它内部的失败 —— 必须挂 .catch()，否则一次写入失败
      // 就变成未处理的 rejection：没有日志，也看不出是哪条偏好没写进去。
      //
      // 刻意不 await：这里是连接关闭路径，后面还有会话摘要等链路。远程 provider
      // 一次超时不该拖住整条关闭流程 —— 用户已经挂断了，资源该释放。写入失败时
      // 候选留在池子里，下一场会话结束自动重试。
      const promotePreferences = () => {
        try {
          const promoting = preferencePromoter?.run({ ownerId })
          if (promoting?.catch) {
            promoting.catch(error => {
              connectionLogger.warn('preference.promote_hook_failed', {
                error: String(error?.message || error),
              })
            })
          }
        } catch (error) {
          connectionLogger.warn('preference.promote_hook_failed', {
            error: String(error?.message || error),
          })
        }
      }
      try {
        const observing = profileObserver?.maybeRun({ ownerId, sessionId })
        // 观察失败也要照常扫描：池子里可能还有前几场攒下的确认。
        if (observing?.then) observing.then(promotePreferences, promotePreferences)
        else promotePreferences()
      } catch (error) {
        connectionLogger.warn('preference.observe_hook_failed', {
          error: String(error?.message || error),
        })
        promotePreferences()
      }
      // 会话摘要：记下本场聊了什么，供以后 recall 查。
      // 与抽取器、观察器彼此独立 —— 三条链路读同一份转写，但任何一条失败都不该
      // 连带丢掉另外两条的产出，所以各自 try 各自 catch。
      try {
        sessionSummariser?.maybeRun({ ownerId, sessionId })
      } catch (error) {
        connectionLogger.warn('session_digest.summarise_hook_failed', {
          error: String(error?.message || error),
        })
      }
      // 滚动摘要取走即删：本场摘要已被上面的下游消费，留着等于悄悄开启了
      // 「每场会话长期留存完整摘要」，那需要用户显式同意。
      try {
      } catch (error) {
        connectionLogger.warn('rolling_summary.drop_failed', {
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
