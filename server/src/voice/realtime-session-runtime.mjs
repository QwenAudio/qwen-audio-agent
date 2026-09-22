import { randomUUID } from 'node:crypto'
import { normalizeInputParts } from '../../../shared/input-parts.mjs'
import { GatewayClientEvent, GatewayServerEvent } from '../../../shared/protocol/realtime-events.mjs'
import { AnnouncementWindow } from './announcement/announcement-window.mjs'
import { normalizeClientContext } from '../conversation/frontend-agent-context.mjs'
import { realtimeEventErrorMessage } from './realtime-provider.mjs'
import { SessionTaskCoordinator } from '../orchestration/session-task-coordinator.mjs'
import { createRealtimeTaskPresentation } from './realtime-task-presentation.mjs'
import { recordTaskResult } from '../conversation/task-result-projector.mjs'
import { ToolCallHandler } from '../frontend/tools/tool-call-handler.mjs'
import { buildFrontendToolContext } from '../frontend/tools/frontend-tool-context.mjs'
import { TurnTranscripts } from '../frontend/tools/turn-transcripts.mjs'
import { TurnCitations } from './turn-citations.mjs'
import { RealtimeInputRuntime } from './realtime-input-runtime.mjs'
import { acceptsPlaybackReceipt, RealtimePresentationRuntime } from './realtime-presentation-runtime.mjs'
import { RealtimeTurnState } from './realtime-turn-state.mjs'
import { clientVoiceCapabilities } from '../client/active-voice-clients.mjs'
import { RealtimeProviderSession } from './realtime-provider-session.mjs'
import { VisualInputBuffer } from './visual-input-buffer.mjs'
import { RealtimeRecoveryContext } from './realtime-recovery-context.mjs'
import { SleepController } from './sleep-controller.mjs'
import { isResponseActivityEvent, realtimeResponseId } from './response-lifecycle.mjs'
import { frontendSourceToolDefinitions } from '../frontend/tools/frontend-tool-source.mjs'
import { createGatewaySystemEventDelivery, GatewaySystemEvent } from '../delivery/gateway-system-event.mjs'
import { RealtimeAgentDeliveryRuntime } from './realtime-agent-delivery-runtime.mjs'
import { ClientActionName, ClientActionPort } from '../client/client-action-port.mjs'
import { PresenceController } from '../client/presence-controller.mjs'

const MAX_PENDING_AUDIO_CHUNKS = 30
const RESPONSE_START_WATCHDOG_MS = 12000
const PERMISSION_RESPONSE_GRACE_MS = 800
const RESPONSE_CONTEXT_CLEANUP_MS = 30000
const REALTIME_STABLE_CONNECTION_MS = 10000

function gatewayTurnId() {
  return `gateway_${randomUUID().replaceAll('-', '')}`
}

export function isSleepActivityEvent(event = {}) {
  return isResponseActivityEvent(event) || [
    'input_audio_buffer.speech_started',
    'input_audio_buffer.speech_stopped',
    'conversation.item.input_audio_transcription.delta',
    'conversation.item.input_audio_transcription.completed',
  ].includes(event.type)
}

/**
 * One frontend conversation runtime per client connection.
 * Receives decoded semantic input plus trusted identity; emits internal events.
 * It never owns a socket, protocol handshake, credential or connection lease.
 * Task policy stays in orchestration; providers, turns and playback stay here.
 */
export function createRealtimeSessionRuntime({
  ownerId, sessionId, send, logger: connectionLogger, observers,
  voiceAccess, actionCapabilities, initialInputSuspension = null,
  onTaskEvent, onResponseDone = () => {},
  frontendToolSourcesReady = Promise.resolve(),
  memoryService, sessionDigests, notesStore,
  taskManager, taskOperations, backendRuntime, backendAvailability,
  respondAuthorization, respondInput, permissionPolicy,
  inputAssets, conversationSync, config, realtimeProviderRegistry,
  defaultRealtimeProvider, realtimeFrontendFactory,
  frontendRetrieval, frontendKnowledge, frontendToolSources,
  spawnThinkingDescription, taskAnnouncementFactory,
}) {
  let closed = false
  let started = false
  let inactivityTimer = null
  const emit = event => { if (!closed) send(event) }
  let inputEnabled = false
  let outputEnabled = false
  // Set only by host arbitration. Unlike inputEnabled (which the client
  // declares about itself) this means the client has been ordered to stop
  // capturing, so nothing here may re-enable audio on its own.
  let inputSuspended = initialInputSuspension?.suspended === true
  let nonVoiceClient = false
  let descriptor = { type: 'unknown', instanceId: null }
  let responseTurnCandidate = null
  let responseStartWatchdog = null
  let permissionResponseTimer = null
  let sleeping = false
  let waking = false
  let sleepController
  const clientActionCapabilities = new Set()
  const toolScope = new AbortController()
  const clientActions = new ClientActionPort({
    send: emit,
    getCapabilities: () => [...clientActionCapabilities],
    capabilityForAction: name => actionCapabilities[name],
  })
  const presenceController = new PresenceController({
    clientActions,
    beforeSleep: async () => {
      inputEnabled = false
      realtimeSession.clearPendingAudio()
    },
    onSleeping: () => enterSleep(),
    onFailure: ({ error }) => connectionLogger.warn('presence.sleep_failed', {
      code: String(error?.code || 'client_action_failed'),
      error: String(error?.message || error),
    }),
  })
  const announcementWindow = new AnnouncementWindow()
  let clientContext = normalizeClientContext()
  let sessionAssistantProfile = ''
  let sessionOutputVoice = ''
  const turns = new RealtimeTurnState()
  const transcripts = new TurnTranscripts()
  const turnCitations = new TurnCitations()
  let realtimeSession
  let visualInput
  const clearVisualInput = () => {
    realtimeSession?.clearPendingImage?.()
    visualInput?.reset?.()
  }
  const agentDeliveries = new RealtimeAgentDeliveryRuntime({
    getFrontend: () => realtimeSession?.frontend,
    isDeliveryBlocked: () => (
      sleeping
      || waking
      || !outputEnabled
      || !realtimeSession?.ready
    ),
  })
  const observeSessionAudio = event => observers.emit('onAudio', {
    ownerId, sessionId, event, logger: connectionLogger,
  })
  // Keep visible history intact while excluding only a provider-rejected turn
  // from future Realtime Session restoration.
  const realtimeRecoveryContext = new RealtimeRecoveryContext()
  const frontendRecentMessages = () => realtimeRecoveryContext.project(
    conversationSync.frontendContext({ ownerId, sessionId }),
  )
  const getAgentContext = () => ({
    client: clientContext,
    frontend: {
      ...(spawnThinkingDescription ? { spawnThinkingDescription } : {}),
      ...buildFrontendToolContext({
        disabledTools: config.frontendDisabledTools || [],
        backendAvailability,
        frontendRetrieval,
        frontendKnowledge,
        memoryService,
        sessionDigests,
        permissionPending: taskCoordinator.hasPendingPermission(),
        inputPending: taskCoordinator.hasPendingInput(),
      }),
      tools: frontendSourceToolDefinitions(frontendToolSources),
    },
    memories: memoryService?.list(ownerId, { limit: 64 }) || [],
    recentMessages: frontendRecentMessages(),
    ...(sessionAssistantProfile
      ? { assistantProfile: sessionAssistantProfile }
      : {}),
  })
  const taskCoordinator = new SessionTaskCoordinator({
    taskManager,
    ownerId,
    sessionId,
    retryMs: config.announcementQuietMs,
    presentation: createRealtimeTaskPresentation({
      getState: () => ({
        ready: realtimeSession?.ready === true,
        outputEnabled, sleeping, waking,
        windowBlocked: announcementWindow.isBlocked(),
        busy: turns.userSpeaking || announcementWindow.isBlocked(),
      }),
      getFrontend: () => realtimeSession?.frontend,
      deliveryRuntime: agentDeliveries,
      updateContext: () => realtimeSession.updateAgentContext(getAgentContext()),
      cancelPermission: id => presentationRuntime.cancelPermission(id),
      taskAnnouncementFactory,
      config,
      onError: message => emit({ type: 'error', message }),
      onProgressError: error => connectionLogger.warn('progress.injection_failed', {
        error: error.message,
      }),
    }),
    onTaskEvent,
    onResult: task => recordTaskResult({ conversationSync, ownerId, sessionId, task }),
    onWake: () => wakeFromSleep(),
  })
  const { results: announcements, progress: progressAnnouncements } = taskCoordinator.announcements
  const reportFrontendError = error => {
    if (error?.realtimeConnectionReported) return
    if (error) error.realtimeConnectionReported = true
    emit({ type: GatewayServerEvent.ERROR, message: error?.message || String(error) })
  }
  realtimeSession = new RealtimeProviderSession({
    providerRegistry: realtimeProviderRegistry,
    defaultProvider: defaultRealtimeProvider,
    getAgentContext,
    getSessionOptions: () => ({
      ...(sessionOutputVoice ? { voice: sessionOutputVoice } : {}),
    }),
    shouldReconnect: () => inputEnabled || outputEnabled,
    onEvent: event => handleEvent(event),
    onDiagnostic: diagnostic => {
      const { event, ...fields } = diagnostic
      connectionLogger.warn(event, fields)
    },
    onConnected: () => {
      taskCoordinator.announcePendingPermissions()
      taskCoordinator.announcePendingInputs()
    },
    onReady: createdFrontend => {
      const resumedFromSleep = waking
      waking = false
      if (outputEnabled) taskCoordinator.claimPendingNotifications()
      emit({
        type: GatewayServerEvent.VOICE_READY,
        inputSampleRate: createdFrontend.provider.inputSampleRate,
        provider: createdFrontend.provider.key,
        providerLabel: createdFrontend.provider.label,
      })
      sleepController.recordActivity()
      progressAnnouncements.flush()
      if (resumedFromSleep) {
        emit({
          type: GatewayServerEvent.VOICE_SLEEP,
          state: 'awake',
        })
        taskCoordinator.announcePendingPermissions()
        taskCoordinator.announcePendingInputs()
        taskCoordinator.claimPendingNotifications()
        announcements.flush()
      }
    },
    onDisconnected: () => {
      clearVisualInput()
      emit({
        type: GatewayServerEvent.VOICE_STATE,
        state: 'idle',
      })
    },
    onReconnected: () => {
      announcements.flush()
      progressAnnouncements.flush()
    },
    onConnectionState: event => emit({
      type: GatewayServerEvent.VOICE_CONNECTION,
      ...event,
    }),
    onError: reportFrontendError,
    onReconnectError: error => emit({
      type: GatewayServerEvent.ERROR,
      message: `实时语音连接恢复失败：${error.message}`,
    }),
    logger: connectionLogger,
    maxPendingAudioChunks: MAX_PENDING_AUDIO_CHUNKS,
    stableConnectionMs: REALTIME_STABLE_CONNECTION_MS,
    ...(realtimeFrontendFactory
      ? { createFrontend: realtimeFrontendFactory }
      : {}),
  })
  visualInput = new VisualInputBuffer({
    onFrame: image => realtimeSession.appendImage(image),
  })
  const applyInputSuspension = status => {
    if (closed) return
    const suspend = status.suspended === true
    if (suspend === inputSuspended) return
    inputSuspended = suspend
    if (suspend) {
      // Buffered audio predates the suspension and is no longer wanted.
      realtimeSession.clearPendingAudio()
      realtimeSession.setInputMuted(true)
      clearVisualInput()
      sleepController?.disable()
      realtimeSession.cancelResponse()
      emit({ type: GatewayServerEvent.PLAYBACK_CLEAR, reason: 'input_suspended' })
      emit({
        type: GatewayServerEvent.INPUT_SUSPEND,
        owner: status.owner,
        reason: status.reason,
        expiresAt: status.expiresAt,
      })
      return
    }
    if (inputEnabled) realtimeSession.setInputMuted(false)
    emit({ type: GatewayServerEvent.INPUT_RESUME })
  }
  const deactivate = holder => {
    if (closed) return
    sleeping = false
    waking = false
    presenceController.wake()
    sleepController?.disable()
    releaseVoiceClient()
    clearVisualInput()
    announcementWindow.reset()
    announcements.pause()
    realtimeSession.close({ notifyDisconnected: true })
    emit({ type: 'playback.clear' })
    emit({
      type: 'voice.deactivated',
      holder: holder || null,
    })
  }
  const activateVoiceClient = ({
    enableInput = true,
    enableOutput = true,
  } = {}) => {
    const result = voiceAccess.claim()
    inputEnabled = result.granted && enableInput
    outputEnabled = result.granted && enableOutput
    voiceAccess.changed()
    return result.granted
  }
  const releaseVoiceClient = () => {
    inputEnabled = false
    outputEnabled = false
    progressAnnouncements.clear()
    if (voiceAccess.release()) {
      voiceAccess.changed()
    }
  }
  const toolCallTimings = new Map()
  // Client-side edits are not present in the model's conversation. Refresh
  // the owner's live memory snapshot after persistence, including deletion.
  // Same-session tool writes already return the new documents to the model;
  // retain their existing cache-only path to avoid a redundant prompt update.
  const unsubscribeMemory = typeof memoryService?.subscribe === 'function'
    ? memoryService.subscribe(event => {
        if (event.ownerId !== ownerId) return
        // Persistence changes invalidate the client view regardless of their
        // source or whether this session needs a model-instruction refresh.
        emit({ type: GatewayServerEvent.MEMORY_CHANGED })
        realtimeSession.updateAgentContext({
          memories: memoryService.list(ownerId, { limit: 64 }),
        }, {
          refreshSession: event.source !== 'realtime-tool' || event.sessionId !== sessionId,
        })
      })
    : () => {}
  const toolCalls = new ToolCallHandler({
    taskManager,
    taskOperations,
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
    onMemoryChanged: () => {
      realtimeSession.updateAgentContext({
        memories: memoryService?.list(ownerId, { limit: 64 }) || [],
      }, { refreshSession: false })
      if (typeof memoryService?.subscribe !== 'function') {
        emit({ type: GatewayServerEvent.MEMORY_CHANGED })
      }
    },
    backendRuntime,
    backendAvailability,
    respondAuthorization,
    respondInput,
    permissionPolicy,
    // The permission decision was accepted locally but never reached the
    // backend: the authorization is still pending there, so clear the
    // announced mark and let the standard re-announce path ask again.
    onPermissionDeliveryFailed: ({ authorizationId, error }) => {
      connectionLogger.warn('permission.delivery_failed', {
        authorizationId,
        error,
      })
      taskCoordinator.retryPermission(authorizationId)
    },
    onToolResultReady: ({ callId, turnId, toolName }) => {
      const timing = toolCallTimings.get(callId)
      if (!timing || timing.resultReady) return
      timing.resultReady = true
      connectionLogger.info('realtime.tool_call.result_ready', {
        ...timing.fields,
        turnId: turnId || timing.fields.turnId,
        toolName: toolName || timing.fields.toolName,
        durationMs: Math.max(0, Date.now() - timing.startedAt),
      })
    },
    onToolCallDebug: event => {
      const { startedAt: _startedAt, ...publicEvent } = event || {}
      emit({
        type: GatewayServerEvent.TOOL_CALL,
        ...publicEvent,
      })
    },
    presenceController,
    onAgentActivity: activity => emit({
      type: GatewayServerEvent.AGENT_ACTIVITY,
      ...activity,
    }),
    inputAssets,
    frontendRetrieval,
    frontendKnowledge,
    disabledTools: config.frontendDisabledTools || [],
    frontendToolSources,
    externalToolContext: {
      ownerId,
      sessionId,
      signal: toolScope.signal,
      supportsClientAction: name => clientActions.supports(name),
      requestClientAction: (name, args, options) => clientActions.request(name, args, {
        ...options,
        signal: options?.signal || toolScope.signal,
      }),
      registerInputs: (parts, turnId) => inputAssets.metadataForParts(inputAssets.registerParts({
        ownerId, sessionId, turnId, parts: normalizeInputParts(parts),
      })),
      deliver: (delivery, options) => agentDeliveries.deliver(delivery, options),
    },
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
    const hasPendingPermission = () => taskCoordinator.hasPendingPermission()
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
      }).catch(error => emit({
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
      emit({
        type: 'error',
        message: '实时模型没有开始回复，语音连接已自动恢复，请再说一次。',
      })
      emit({
        type: 'voice.state',
        state: 'idle',
        turnId: context.turnId,
        origin: 'model',
      })
      realtimeSession.reconnect().catch(error => emit({
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
    send: event => emit(event),
    getFrontend: () => realtimeSession.frontend,
    ensureFrontend: () => realtimeSession.ensure(),
    clearResponseCandidate,
    expectResponseFor,
    shouldEnsurePermissionResponse: context => responseTurnCandidate === context,
    ensurePermissionResponseFor,
    reportFrontendError,
    onSpeechStarted: fields => {
      connectionLogger.info('realtime.provider.speech_started', fields)
      observeSessionAudio({ type: 'speech_started', ...fields })
    },
    onSpeechStopped: fields => {
      connectionLogger.info('realtime.provider.speech_stopped', fields)
      observeSessionAudio({ type: 'speech_stopped', ...fields })
    },
  })

  const presentationRuntime = new RealtimePresentationRuntime({
    ownerId,
    sessionId,
    turns,
    conversationSync,
    announcementWindow,
    announcements,
    toolCalls,
    send: event => emit(event),
    getFrontend: () => realtimeSession.frontend,
    getOutputEnabled: () => outputEnabled,
    getNonVoiceClient: () => nonVoiceClient,
    getResponseTurnCandidate: () => responseTurnCandidate,
    clearResponseCandidate,
    announcementQuietMs: config.announcementQuietMs,
    responseContextCleanupMs: RESPONSE_CONTEXT_CLEANUP_MS,
    turnCitations,
  })

  taskCoordinator.start()

  const handleEvent = event => {
    if (closed) return
    if (isSleepActivityEvent(event)) sleepController?.recordActivity()
    if (isResponseActivityEvent(event)) presentationRuntime.begin(event)
    if (inputs.handleProviderEvent(event)) return
    if (event.type === 'response.done') {
      const responseId = realtimeResponseId(event)
      const context = presentationRuntime.get(responseId)
      connectionLogger.info('realtime.response.done', {
        responseId,
        turnId: context?.turnId || '',
        status: event.response?.status || '',
        hasAudio: Boolean(context?.hasAudio),
        hasFunctionCall: Boolean(context?.hasFunctionCall),
        suppressed: Boolean(context?.suppressed),
      })
    }
    if (event.type === 'response.function_call_arguments.done') {
      const id = realtimeResponseId(event)
      const callContext = presentationRuntime.get(id)
        || { turnId: '', turnGeneration: -1 }
      const callFields = {
        responseId: id,
        callId: event.call_id || event.item?.call_id || '',
        toolName: event.name || event.item?.name || '',
        turnId: callContext.turnId || '',
      }
      connectionLogger.info('realtime.tool_call.received', callFields)
      presentationRuntime.markFunctionCall(id)
      const startedAt = Date.now()
      toolCallTimings.set(callFields.callId, {
        fields: callFields,
        startedAt,
        resultReady: false,
      })
      toolCalls.handle(event, { ...callContext, responseId: id })
        .catch(error => {
          connectionLogger.warn('realtime.tool_call.failed', {
            ...callFields,
            durationMs: Math.max(0, Date.now() - startedAt),
            error,
          })
          emit({ type: 'error', message: error.message })
        })
        .finally(() => toolCallTimings.delete(callFields.callId))
    } else if (presentationRuntime.handle(event)) {
      // Alternative transports distinguish generation from audio delivery.
      // Existing client events stay unchanged.
      if (event.type === 'response.done') {
        onResponseDone({
          id: realtimeResponseId(event),
          status: event.response?.status || 'unknown',
        })
      }
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
        taskCoordinator.scheduleRetry()
        return
      }
      // 取消撞上已完成响应的良性竞态:提供方回"无进行中响应",对用户无意义,
      // 也不应触发失败簿记(此时本就没有响应在跑)。
      const benignCancelRace = providerError === 'no_active_response'
      if (benignCancelRace) return
      if (providerError === 'content_safety') {
        const recentMessages = conversationSync.frontendContext({ ownerId, sessionId })
        const failedContext = presentationRuntime.get(realtimeResponseId(event)) || {
          turnId: turns.committedTurnId || turns.turnId,
        }
        realtimeRecoveryContext.excludeFailure(failedContext, recentMessages)
        clearResponseCandidate()
        presentationRuntime.failResponse(event)
        emit({
          type: GatewayServerEvent.PLAYBACK_CLEAR,
          reason: 'provider_content_safety',
        })
        emit({
          type: GatewayServerEvent.VOICE_STATE,
          state: 'idle',
          origin: 'model',
        })
        connectionLogger.warn('realtime.content_safety_recovery', {
          provider: realtimeSession.providerKey,
          excludedTurnId: failedContext.turnId || '',
        })
        emit({
          type: 'error',
          message: '这次内容未能处理，语音会话已自动恢复，请换个说法再试。',
        })
        const recoveryTurnId = gatewayTurnId()
        const recoveryDelivery = createGatewaySystemEventDelivery(
          GatewaySystemEvent.REALTIME_CONTENT_REJECTED,
          {
            id: `content_recovery_${recoveryTurnId}`,
            correlation: { turnId: recoveryTurnId },
          },
        )
        realtimeSession.reconnect()
          .then(() => agentDeliveries.deliver(recoveryDelivery))
          .then(outcome => {
            if (outcome?.completed) return
            connectionLogger.warn('realtime.content_safety_delivery_skipped', {
              provider: realtimeSession.providerKey,
              blocked: outcome?.blocked === true,
              unavailable: outcome?.unavailable === true,
            })
          })
          .catch(error => emit({
            type: 'error',
            message: error.message,
          }))
        return
      }
      if (providerError === 'fatal') {
        connectionLogger.error('realtime.blocked', {
          provider: realtimeSession.providerKey,
          classification: providerError,
          errorMessage,
        })
        realtimeSession.block(errorMessage)
        emit({
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
        emit({ type: 'error', message: errorMessage })
      }
    }
  }

  const enterSleep = () => {
    if (sleeping) return
    clearVisualInput()
    sleeping = true
    waking = false
    announcementWindow.reset()
    progressAnnouncements.clear()
    emit({
      type: GatewayServerEvent.VOICE_SLEEP,
      state: 'sleeping',
    })
  }

  // Sleep is a Client presence transition: mute input and hide the surface,
  // but retain the Realtime connection and its conversation context.
  // Desktop decides when it is safe to hide because only the client knows
  // about visible work, permission prompts and playback.
  const requestExplicitSleep = (source = 'client') => {
    presenceController.requestSleep({ source }).catch(error => {
      emit({
        type: GatewayServerEvent.ERROR,
        message: `休眠没有完成：${error.message}`,
      })
    })
    return true
  }

  const wakeFromSleep = () => {
    if (!sleeping || waking) return
    sleeping = false
    waking = false
    presenceController.wake()
    sleepController.wake()
    emit({
      type: GatewayServerEvent.VOICE_SLEEP,
      state: 'awake',
    })
    taskCoordinator.announcePendingPermissions()
    taskCoordinator.announcePendingInputs()
    taskCoordinator.claimPendingNotifications()
    announcements.flush()
    progressAnnouncements.flush()
  }

  sleepController = new SleepController({
    timeoutMs: config.sleepTimeoutMs,
    canSleep: () => (
      inputEnabled
      && voiceAccess.isActive()
      && realtimeSession.ready
      && !turns.userSpeaking
      && !announcementWindow.isBlocked()
      && !realtimeSession.connecting
      && !waking
    ),
    onSleep: () => presenceController.requestSleep({
      source: 'timeout',
      requireClientAction: false,
    }).catch(error => connectionLogger.warn('presence.timeout_failed', {
      error: error.message,
    })),
  })

  const updateSessionOutputVoice = voice => {
    if (closed) throw new Error('Frontend session is closed')
    const nextVoice = String(voice || '').trim()
    const provider = realtimeSession.provider()
    if (provider.capabilities?.sessionOutputVoice !== true) {
      const error = new Error(
        `${provider.label} does not support session output voice updates`,
      )
      error.code = 'output_voice_unsupported'
      throw error
    }
    if (nextVoice === sessionOutputVoice) {
      return {
        voice: nextVoice,
        changed: false,
        reconnecting: false,
      }
    }

    sessionOutputVoice = nextVoice
    const hasUpstreamSession = realtimeSession.ready || realtimeSession.connecting
    if (hasUpstreamSession) {
      realtimeSession.cancelResponse()
      emit({
        type: GatewayServerEvent.PLAYBACK_CLEAR,
        reason: 'output_voice_changed',
      })
      // Realtime providers apply voice selection when a Session is created.
      // Rebuild only that provider Session; the GCP client and Gateway
      // conversation remain connected and keep their state.
      realtimeSession.detach({ clearAudio: false })
    }
    const reconnecting = hasUpstreamSession && (inputEnabled || outputEnabled)
    if (reconnecting) realtimeSession.ensure().catch(reportFrontendError)
    return {
      voice: nextVoice,
      changed: true,
      reconnecting,
    }
  }
  const handleClientDelivery = result => {
    if (closed) return
    const automaticSleep = (
      !result.duplicate
      && result.name === 'desktop.presence.sleep_requested'
    )
    if (!result.duplicate && result.delivery) {
      agentDeliveries.deliver(result.delivery).then(outcome => {
        if (outcome?.completed || outcome?.handled) return
        connectionLogger.warn('client_event.delivery_skipped', {
          name: result.name,
          mode: result.delivery.mode,
          blocked: outcome?.blocked === true,
          unavailable: outcome?.unavailable === true,
        })
      }).catch(error => connectionLogger.warn('client_event.delivery_failed', {
        name: result.name,
        error: error.message,
      }))
    }
    if (automaticSleep) {
      // The Client Event informs the frontend model of the environment
      // transition, but automatic sleep is deterministic client policy.
      // It must not wait for the model to call enter_sleep again.
      clearTimeout(inactivityTimer)
      inactivityTimer = setTimeout(() => {
        inactivityTimer = null
        if (!closed && !sleeping) requestExplicitSleep('client_inactivity')
      }, 100)
      inactivityTimer.unref?.()
    }
  }

  const handleClientEvent = (event, { descriptor: nextDescriptor = descriptor, capabilities: negotiatedCapabilities = [] } = {}) => {
    if (closed) return
    if (event.type === GatewayClientEvent.CONNECT) {
      descriptor = nextDescriptor
      connectionLogger.info('voice_client.configured', {
        clientType: descriptor.type,
        clientLabel: descriptor.label,
        requestedProvider: event.provider || realtimeSession.providerKey,
        inputEnabled: event.inputEnabled === true,
        outputEnabled: event.outputEnabled === true,
        textOnly: event.textOnly === true,
      })
      nonVoiceClient = event.textOnly === true
      sessionOutputVoice = String(event.outputVoice || '').trim()
      // The client may pick a realtime front end per session. An unknown
      // name is reported instead of silently falling back, so a typo does
      // not look like a working session on the wrong provider.
      if (event.provider && event.provider !== realtimeSession.providerKey) {
        try {
          realtimeSession.switchProvider(event.provider)
        } catch (error) {
          emit({ type: 'error', message: error.message })
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
          enableInput: capabilities.inputEnabled,
          enableOutput: capabilities.outputEnabled,
        })
      } else {
        releaseVoiceClient()
        inputEnabled = capabilities.inputEnabled
        outputEnabled = capabilities.outputEnabled
        voiceAccess.changed()
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
      clientActionCapabilities.clear()
      for (const capability of Object.values(actionCapabilities)) {
        if (negotiatedCapabilities.includes(capability)) clientActionCapabilities.add(capability)
      }
      if (
        negotiatedCapabilities.includes(
          actionCapabilities[ClientActionName.ENTER_SLEEP],
        )
        || clientContext.states.includes('sleeping')
      ) {
        clientActionCapabilities.add(
          actionCapabilities[ClientActionName.ENTER_SLEEP],
        )
      }
      clientContext.actions = Object.keys(actionCapabilities).filter(name => clientActions.supports(name))
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
      // An action-capable desktop owns its inactivity policy and publishes a
      // semantic request. Keep Gateway's legacy timer only for clients that
      // cannot request a synchronized Client Action transition.
      sleepController.setTimeoutMs(
        clientActions.supports(ClientActionName.ENTER_SLEEP)
          ? 0
          : config.sleepTimeoutMs,
      )
      frontendToolSourcesReady.then(() => {
        if (closed) return
        realtimeSession.updateAgentContext(getAgentContext())
        if (sleeping) {
          sleeping = false
          waking = true
          presenceController.wake()
          sleepController.wake()
        }
        if (event.wakeWordOnly === true) {
          requestExplicitSleep()
        } else if (inputEnabled || outputEnabled) {
          realtimeSession.ensure().catch(reportFrontendError)
        }
      }).catch(reportFrontendError)
    } else if (event.type === GatewayClientEvent.UNMUTE) {
      if (nonVoiceClient) {
        inputEnabled = false
        outputEnabled = true
        voiceAccess.changed()
      } else {
        activateVoiceClient()
      }
      realtimeSession.setInputMuted(false)
      realtimeSession.ensure()
        .then(() => {
          taskCoordinator.announcePendingPermissions()
          taskCoordinator.announcePendingInputs()
          taskCoordinator.claimPendingNotifications()
          announcements.flush()
        })
        .catch(reportFrontendError)
    } else if (event.type === GatewayClientEvent.INPUT_UNMUTE) {
      if (nonVoiceClient) return
      if (voiceAccess.isActive()) {
        inputEnabled = true
        outputEnabled = true
        voiceAccess.changed()
      } else {
        activateVoiceClient()
      }
      realtimeSession.setInputMuted(false)
      if (sleeping) {
        return
      }
      realtimeSession.ensure()
        .then(() => {
          taskCoordinator.announcePendingPermissions()
          taskCoordinator.announcePendingInputs()
          taskCoordinator.claimPendingNotifications()
          announcements.flush()
        })
        .catch(reportFrontendError)
    } else if (event.type === GatewayClientEvent.AUDIO_APPEND) {
      if (sleeping) return
      if (
        !inputEnabled
        // Defence in depth: a client that has not yet acted on the suspension
        // must not be able to feed audio through it.
        || inputSuspended
        || !voiceAccess.isActive()
      ) {
        return
      }
      realtimeSession.appendAudio(event.audio)
      observeSessionAudio({
        type: 'chunk',
        audio: event.audio,
        sampleRate: Number(realtimeSession.provider()?.inputSampleRate) || 16_000,
      })
    } else if (event.type === GatewayClientEvent.IMAGE_APPEND) {
      if (
        sleeping
        || !inputEnabled
        || inputSuspended
        || !voiceAccess.isActive()
      ) return
      try {
        visualInput.append({
          image: event.image,
          mediaType: event.media_type,
          occurredAt: event.occurred_at,
        })
      } catch (error) {
        emit({
          type: GatewayServerEvent.ERROR,
          message: error.message,
        })
      }
    } else if (event.type === GatewayClientEvent.IMAGE_CLEAR) {
      if (!voiceAccess.isActive()) return
      clearVisualInput()
    } else if (
      event.type === GatewayClientEvent.TEXT_MESSAGE
      || event.type === GatewayClientEvent.INPUT_MESSAGE
    ) {
      if (sleeping || waking) {
        emit({
          type: 'error',
          message: '当前客户端已休眠，请先唤醒后再继续。',
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
      const playbackContext = presentationRuntime.get(id)
      if (acceptsPlaybackReceipt({
        outputEnabled,
        active: voiceAccess.isActive(),
        responseKnown: presentationRuntime.has(id),
      })) {
        connectionLogger.info('realtime.playback.started', {
          responseId: id,
          turnId: playbackContext?.turnId || '',
          origin: playbackContext?.origin || 'model',
        })
        presentationRuntime.startPlayback(id)
      }
    } else if (event.type === GatewayClientEvent.PLAYBACK_ENDED) {
      const id = String(event.responseId || '')
      const accepted = acceptsPlaybackReceipt({
        outputEnabled,
        active: voiceAccess.isActive(),
        responseKnown: presentationRuntime.has(id),
      })
      connectionLogger.info('realtime.playback.ended', { responseId: id, accepted })
      if (accepted) presentationRuntime.finishPlayback(id)
    } else if (event.type === GatewayClientEvent.PLAYBACK_CANCELLED) {
      const id = String(event.responseId || '')
      const accepted = acceptsPlaybackReceipt({
        outputEnabled,
        active: voiceAccess.isActive(),
        responseKnown: presentationRuntime.has(id),
      })
      connectionLogger.info('realtime.playback.cancelled', {
        responseId: id, accepted, reason: String(event.reason || ''),
      })
      if (accepted) {
        presentationRuntime.cancelPlayback(id, {
          reason: String(event.reason || ''),
        })
      }
    } else if (event.type === GatewayClientEvent.MUTE) {
      clearVisualInput()
      releaseVoiceClient()
      sleeping = false
      waking = false
      presenceController.wake()
      sleepController?.disable()
      turns.advanceBoundary()
      announcementWindow.reset()
      progressAnnouncements.clear()
      realtimeSession.close({ notifyDisconnected: true })
    } else if (event.type === GatewayClientEvent.INPUT_MUTE) {
      inputEnabled = false
      realtimeSession.clearPendingAudio()
      realtimeSession.setInputMuted(true)
      clearVisualInput()
    } else if (event.type === GatewayClientEvent.SLEEP) {
      requestExplicitSleep('client')
    } else if (event.type === GatewayClientEvent.WAKE) {
      // 桌面快捷键/托盘唤起恢复可见性和输入；Realtime 连接在休眠期间保持。
      if (sleeping) wakeFromSleep()
      else sleepController.recordActivity()
    } else if (event.type === GatewayClientEvent.INPUT_SUSPEND_ACK) {
      connectionLogger.debug('input.suspend_acknowledged', {
        clientType: descriptor.type,
        owner: String(event.owner || '') || null,
      })
    }
  }

  return {
    start() {
      if (closed || started) return
      started = true
      emit({ type: GatewayServerEvent.VOICE_STATE, state: 'idle' })
      if (inputSuspended) emit({
        type: GatewayServerEvent.INPUT_SUSPEND,
        owner: initialInputSuspension.owner,
        reason: initialInputSuspension.reason,
        expiresAt: initialInputSuspension.expiresAt,
      })
    },
    handleClientEvent,
    handleClientDelivery,
    applyInputSuspension,
    deactivate,
    status: () => realtimeSession.status({ sleeping, waking }),
    updateOutputVoice: updateSessionOutputVoice,
    setAssistantProfile(profile) {
      if (closed) return
      sessionAssistantProfile = String(profile || '').trim()
      realtimeSession.updateAgentContext(getAgentContext())
    },
    receiveActionResult: message => !closed && clientActions.receive(message),
    close() {
      if (closed) return
      closed = true
      clearTimeout(inactivityTimer)
      toolScope.abort(new Error('Client disconnected'))
      releaseVoiceClient()
      taskCoordinator.close()
      unsubscribeMemory()
      clearResponseCandidate()
      turns.close()
      transcripts.close()
      turnCitations.clear()
      announcementWindow.reset()
      presentationRuntime.clear()
      clearVisualInput()
      sleepController?.close()
      presenceController.close()
      realtimeSession.close()
      observeSessionAudio({ type: 'session_ended' })
      observers.emit('onSessionClosed', { ownerId, sessionId, logger: connectionLogger })
    },
  }
}
