import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import {
  GatewayClientEvent,
  GatewayServerEvent,
} from '../../shared/realtime-events.mjs'
import {
  acceptsGatewayVoiceState,
  createGatewayClientState,
  reduceGatewayClientState,
} from '../../shared/gateway-client-state.mjs'
import { clientInputCapabilities } from '../../shared/client-input-capabilities.mjs'
import {
  createGatewayProtocolEventId,
  GatewayClientProtocolEvent,
} from '../../shared/gateway-client-protocol.mjs'
import { GatewayClient } from '../../shared/gateway-client-sdk.mjs'
import { gatewayReferenceClientCapabilities } from '../../shared/gateway-client-profiles.mjs'
import { decodePcm, pcmBase64, resample } from './audio.js'
import { createMicrophoneCaptureLifecycle } from './microphone-capture.js'
import { confirmTrackedPlaybackStart } from './playback-lifecycle.js'
import { t } from './i18n.js'

const DEFAULT_INPUT_RATE = 16000
const OUTPUT_RATE = 24000

function socketUrl(sessionId) {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const basePath = location.pathname.endsWith('/')
    ? location.pathname
    : location.pathname.replace(/[^/]*$/, '')
  return `${protocol}//${location.host}${basePath}api/realtime?sessionId=${encodeURIComponent(sessionId)}`
}

export function acceptsVoiceState(event, currentTurnId) {
  return acceptsGatewayVoiceState(event, currentTurnId)
}

export function visualVoiceState(state) {
  return state
}

export function shouldClaimReleasedVoice(event, waitingForVoice) {
  return (
    waitingForVoice === true
    && event?.type === 'voice.ownership'
    && event.state === 'available'
  )
}

export function shouldAdvertiseVoice(enabled, inputReady) {
  return enabled === true && inputReady === true
}

export function realtimeClientMode({
  enabled,
  inputReady,
  inputOnlyMute = false,
  wakeWordOnly = false,
} = {}) {
  // A fully disabled client does not participate in voice arbitration. This
  // flag never changes upstream Realtime modalities. Microphone-only mute
  // keeps the client audio-capable and leaves output playback active.
  const textOnly = enabled !== true && inputOnlyMute !== true
  const inputEnabled = shouldAdvertiseVoice(enabled, inputReady)
    && wakeWordOnly !== true
  return {
    textOnly,
    inputEnabled,
    // A non-voice client still needs output events and task notifications, but
    // it must not claim voice ownership.
    outputEnabled: textOnly || inputOnlyMute === true || inputEnabled,
  }
}

export function gatewayClientCapabilities({ clientType = 'web' } = {}) {
  return gatewayReferenceClientCapabilities(clientType)
}

// Keeps a persisted front end selection only while the server still offers it.
// A stale key would be refused on every connect, so it degrades to the empty
// value that means "use the server default".
export function retainedRealtimeProvider(selected, providers) {
  if (!selected) return ''
  const offered = (providers || []).some(provider => provider.key === selected)
  return offered ? selected : ''
}

const INPUT_CAPABILITIES = Object.freeze([
  ['textInput', 'text'],
  ['audioInput', 'audio'],
  ['imageInput', 'image'],
  ['videoInput', 'video'],
])

const TRANSPORT_INPUT_CAPABILITIES = Object.freeze([
  ['textInput', 'text'],
  ['audioInput', 'audio'],
  ['imageInput', 'image'],
  ['observationInput', 'observation'],
  ['nativeVideoInput', 'nativeVideo'],
])

function enabledModes(capabilities, definitions) {
  return definitions
    .filter(([key]) => capabilities?.[key] === true)
    .map(([, mode]) => mode)
}

function sameCapabilities(left, right) {
  if (!left || !right) return false
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  return [...keys].every(key => left[key] === right[key])
}

export function realtimeModelStatus(health = {}) {
  const profile = health.realtimeModelProfile
  const id = String(health.realtimeModel || profile?.id || '').trim()
  const catalogProfile = Array.isArray(health.realtimeModelCatalog)
    ? health.realtimeModelCatalog.find(item => item?.id === id)
    : null
  const hasProfile = Boolean(profile?.id)
  const current = Boolean(
    id
    && profile?.id === id
    && catalogProfile
    && catalogProfile.label === profile.label
    && catalogProfile.family === profile.family
    && sameCapabilities(
      catalogProfile.modelCapabilities,
      profile.modelCapabilities,
    )
    && sameCapabilities(
      catalogProfile.transportCapabilities,
      profile.transportCapabilities,
    )
  )
  const modelCapabilities = current ? profile.modelCapabilities : null
  const transportCapabilities = current ? profile.transportCapabilities : null

  return {
    id,
    label: current ? profile.label : id,
    metadataStatus: current ? 'current' : hasProfile ? 'stale' : 'missing',
    modelInputModes: enabledModes(modelCapabilities, INPUT_CAPABILITIES),
    transportInputModes: enabledModes(
      transportCapabilities,
      TRANSPORT_INPUT_CAPABILITIES,
    ),
    imageInputEnabled: transportCapabilities?.imageInput === true,
  }
}

export function realtimeProviderSelection(selected, health = {}) {
  if (!selected) return { provider: '', recovered: false, notice: '' }
  const advertised = Array.isArray(health.realtimeProviders)
    ? health.realtimeProviders.find(provider => provider?.key === selected)
    : null
  const activeModelId = health.realtimeModelProfile?.id
    || health.realtimeModel
    || ''
  const explicitlySupportsModel = (
    !Array.isArray(advertised?.realtimeModelIds)
    || !activeModelId
    || advertised.realtimeModelIds.includes(activeModelId)
  )
  if (advertised && explicitlySupportsModel) {
    return { provider: selected, recovered: false, notice: '' }
  }
  return {
    provider: '',
    recovered: true,
    notice: '已恢复为服务器默认前台',
  }
}

export function realtimeProviderForConnection(selected, healthValidated) {
  return healthValidated === true ? selected : ''
}

export function microphoneControlEvent({
  enabled,
  inputOnlyMute = false,
  wakeWordOnly = false,
} = {}) {
  if (wakeWordOnly) return { type: GatewayClientEvent.SLEEP }
  if (inputOnlyMute) {
    return enabled
      ? { type: GatewayClientEvent.INPUT_UNMUTE }
      : { type: GatewayClientEvent.INPUT_MUTE }
  }
  return enabled
    ? { type: GatewayClientEvent.UNMUTE }
    : { type: GatewayClientEvent.MUTE }
}

export function microphoneSamplesDuringManualInput(samples, pending = false) {
  if (pending !== true) return samples
  // Keep advancing provider-side VAD with silence so an already-open speech
  // turn can close naturally, without letting ambient sound preempt the new
  // text/image turn.
  return new Float32Array(samples.length)
}

export function releasesManualInputGuard(event, turnId = '') {
  if (!event || typeof event !== 'object') return false
  if (event.type === GatewayServerEvent.ERROR) return true
  if (event.type !== GatewayServerEvent.RESPONSE_STARTED) return false
  return Boolean(turnId) && event.turnId === turnId
}

export default function useRealtimeVoice({
  sessionId,
  enabled,
  suspended = false,
  outputMuted = false,
  inputOnlyMute = false,
  wakeWordOnly = false,
  clientType = 'web',
  clientLabel = 'WebUI',
  clientStates = [],
  realtimeProvider = '',
  onEvent,
  onInputError,
  onClientAction,
  onWakeWordAudio,
}) {
  const [clientState, dispatchClientState] = useReducer(
    reduceGatewayClientState,
    undefined,
    createGatewayClientState,
  )
  const [inputReady, setInputReady] = useState(false)
  const [error, setError] = useState('')
  const [visualError, setVisualError] = useState(false)
  const {
    connectionState,
    ownership,
    voiceState: state,
    wakeWordActive,
  } = clientState
  const eventRef = useRef(onEvent)
  const inputErrorRef = useRef(onInputError)
  const clientActionRef = useRef(onClientAction)
  const wakeWordAudioRef = useRef(onWakeWordAudio)
  const wakeWordOnlyRef = useRef(wakeWordOnly)
  const socketRef = useRef(null)
  const hasConnectedRef = useRef(false)
  const pendingManualInputsRef = useRef([])
  const audioRef = useRef(null)
  const currentTurnId = useRef('')
  const clientInstanceId = useRef(crypto.randomUUID())
  const inputSampleRate = useRef(DEFAULT_INPUT_RATE)
  const clientStatesSignature = [...new Set(
    (Array.isArray(clientStates) ? clientStates : [])
      .filter(state => typeof state === 'string' && state),
  )].sort().join(',')
  const enabledRef = useRef(enabled)
  const inputReadyRef = useRef(false)
  const outputMutedRef = useRef(outputMuted)
  const mutedPlaybackResponses = useRef(new Set())
  const manualInputPendingRef = useRef(false)
  const manualInputTurnRef = useRef('')
  const manualInputTimerRef = useRef(null)
  const playbackRef = useRef({
    cursor: 0,
    sources: [],
    startTimers: new Map(),
    endTimers: new Map(),
    responseEnds: new Map(),
    startedResponses: new Set(),
    sourceCounts: new Map(),
    doneResponses: new Set(),
    failedResponses: new Set(),
  })
  eventRef.current = onEvent
  inputErrorRef.current = onInputError
  clientActionRef.current = onClientAction
  wakeWordAudioRef.current = onWakeWordAudio
  wakeWordOnlyRef.current = wakeWordOnly
  enabledRef.current = enabled
  outputMutedRef.current = outputMuted

  const releaseManualInputGuard = useCallback(() => {
    manualInputPendingRef.current = false
    manualInputTurnRef.current = ''
    clearTimeout(manualInputTimerRef.current)
    manualInputTimerRef.current = null
  }, [])

  const holdManualInputGuard = useCallback(() => {
    manualInputPendingRef.current = true
    manualInputTurnRef.current = ''
    clearTimeout(manualInputTimerRef.current)
    manualInputTimerRef.current = setTimeout(releaseManualInputGuard, 30000)
  }, [releaseManualInputGuard])

  const activateAudio = useCallback(() => {
    const AudioContext = window.AudioContext || window.webkitAudioContext
    if (!AudioContext) {
      setError(t('当前浏览器不支持实时语音播放'))
      setVisualError(true)
      return false
    }
    if (!audioRef.current || audioRef.current.state === 'closed') {
      audioRef.current = new AudioContext()
    }
    audioRef.current.resume().catch(reason => {
      setError(reason?.message || t('语音播放没有成功启用，请再点一次开启语音'))
      setVisualError(true)
    })
    return true
  }, [])

  const sendSocketEvent = useCallback(event => {
    const socket = socketRef.current
    if (socket?.readyState !== WebSocket.OPEN) return false
    try {
      // GatewayClient owns the wire envelope and supplies event_id for every
      // client event. Keeping that responsibility in the SDK prevents audio,
      // microphone, playback, and lifecycle events from drifting out of GCP.
      socket.send(event)
      return true
    } catch {
      return false
    }
  }, [])

  const flushPendingManualInputs = useCallback(() => {
    const pending = pendingManualInputsRef.current
    if (pending.length) holdManualInputGuard()
    while (pending.length) {
      if (!sendSocketEvent(pending[0])) return
      pending.shift()
    }
  }, [holdManualInputGuard, sendSocketEvent])

  const sendPlaybackEvent = useCallback((type, responseId, reason = '') => {
    if (responseId) {
      sendSocketEvent({
        type,
        responseId,
        ...(reason ? { reason } : {}),
      })
    }
  }, [sendSocketEvent])

  const stopPlayback = useCallback((reason = '') => {
    const playback = playbackRef.current
    const activeResponseIds = new Set([
      ...playback.startTimers.keys(),
      ...playback.endTimers.keys(),
      ...playback.startedResponses,
      ...playback.sourceCounts.keys(),
    ])
    for (const timer of playback.startTimers.values()) {
      clearTimeout(timer)
    }
    for (const timer of playback.endTimers.values()) {
      clearTimeout(timer)
    }
    for (const responseId of activeResponseIds) {
      sendPlaybackEvent(GatewayClientEvent.PLAYBACK_CANCELLED, responseId, reason)
    }
    playbackRef.current.sources.forEach(source => {
      try {
        source.stop()
      } catch {
        // Source already stopped.
      }
    })
    playbackRef.current = {
      cursor: 0,
      sources: [],
      startTimers: new Map(),
      endTimers: new Map(),
      responseEnds: new Map(),
      startedResponses: new Set(),
      sourceCounts: new Map(),
      doneResponses: new Set(),
      failedResponses: new Set(),
    }
  }, [sendPlaybackEvent])

  const finishPlaybackIfReady = useCallback(responseId => {
    if (!responseId) return
    const playback = playbackRef.current
    if (
      !playback.startedResponses.has(responseId)
      || !playback.doneResponses.has(responseId)
      || (playback.sourceCounts.get(responseId) || 0) > 0
    ) return
    sendPlaybackEvent(GatewayClientEvent.PLAYBACK_ENDED, responseId)
    const endTimer = playback.endTimers.get(responseId)
    if (endTimer !== undefined) clearTimeout(endTimer)
    playback.endTimers.delete(responseId)
    playback.responseEnds.delete(responseId)
    playback.startedResponses.delete(responseId)
    playback.sourceCounts.delete(responseId)
    playback.doneResponses.delete(responseId)
  }, [sendPlaybackEvent])

  const markAudioDone = useCallback(responseId => {
    if (!responseId) return
    const playback = playbackRef.current
    if (playback.failedResponses.delete(responseId)) return
    playback.doneResponses.add(responseId)
    finishPlaybackIfReady(responseId)
    const responseEnd = playback.responseEnds.get(responseId)
    if (
      !playback.doneResponses.has(responseId)
      || playback.endTimers.has(responseId)
      || !Number.isFinite(responseEnd)
    ) return
    const checkTimelineFinished = () => {
      const current = playbackRef.current
      if (!current.endTimers.has(responseId)) return
      const context = audioRef.current
      const responseEnd = current.responseEnds.get(responseId)
      if (
        !context
        || !Number.isFinite(responseEnd)
        || context.state !== 'running'
        || context.currentTime + 0.01 < responseEnd
      ) {
        const timer = setTimeout(checkTimelineFinished, 50)
        current.endTimers.set(responseId, timer)
        return
      }
      // AudioContext time has crossed the last scheduled sample. Treat that
      // as a reliable fallback when Electron misses AudioBufferSource.onended.
      current.sourceCounts.set(responseId, 0)
      finishPlaybackIfReady(responseId)
    }
    const delay = Math.max(
      0,
      ((responseEnd || audioRef.current?.currentTime || 0)
        - (audioRef.current?.currentTime || 0)) * 1000,
    ) + 50
    const timer = setTimeout(checkTimelineFinished, delay)
    playback.endTimers.set(responseId, timer)
  }, [finishPlaybackIfReady])

  const failPlayback = useCallback((responseId, reason) => {
    const playback = playbackRef.current
    if (responseId && !playback.failedResponses.has(responseId)) {
      playback.failedResponses.add(responseId)
      const timer = playback.startTimers.get(responseId)
      if (timer !== undefined) clearTimeout(timer)
      const endTimer = playback.endTimers.get(responseId)
      if (endTimer !== undefined) clearTimeout(endTimer)
      playback.startTimers.delete(responseId)
      playback.endTimers.delete(responseId)
      playback.responseEnds.delete(responseId)
      playback.startedResponses.delete(responseId)
      playback.sourceCounts.delete(responseId)
      playback.doneResponses.delete(responseId)
      sendPlaybackEvent(
        GatewayClientEvent.PLAYBACK_CANCELLED,
        responseId,
        'playback_error',
      )
    }
    setError(reason?.message || String(reason || t('语音播放失败')))
    setVisualError(true)
  }, [sendPlaybackEvent])

  const consumeMutedAudio = useCallback(responseId => {
    if (!responseId || mutedPlaybackResponses.current.has(responseId)) return
    mutedPlaybackResponses.current.add(responseId)
    sendPlaybackEvent(GatewayClientEvent.PLAYBACK_STARTED, responseId)
  }, [sendPlaybackEvent])

  const finishMutedAudio = useCallback(responseId => {
    if (!responseId || !mutedPlaybackResponses.current.has(responseId)) return
    mutedPlaybackResponses.current.delete(responseId)
    sendPlaybackEvent(GatewayClientEvent.PLAYBACK_ENDED, responseId)
  }, [sendPlaybackEvent])

  const play = useCallback((base64, sampleRate = OUTPUT_RATE, responseId = '') => {
    const context = audioRef.current
    if (!context) {
      failPlayback(responseId, t('语音播放尚未启用'))
      return
    }
    const playback = playbackRef.current
    if (responseId && playback.failedResponses.has(responseId)) return
    if (context.state === 'suspended') {
      context.resume().catch(reason => failPlayback(responseId, reason))
    }
    let source
    let start
    try {
      const samples = decodePcm(base64)
      const buffer = context.createBuffer(1, samples.length, sampleRate)
      buffer.copyToChannel(samples, 0)
      source = context.createBufferSource()
      source.buffer = buffer
      source.connect(context.destination)
      start = Math.max(context.currentTime + 0.02, playback.cursor)
      playback.cursor = start + buffer.duration
      playback.sources.push(source)
      if (responseId) {
        playback.sourceCounts.set(
          responseId,
          (playback.sourceCounts.get(responseId) || 0) + 1,
        )
        playback.responseEnds.set(
          responseId,
          Math.max(playback.responseEnds.get(responseId) || 0, playback.cursor),
        )
      }
    } catch (reason) {
      failPlayback(responseId, reason)
      return
    }
    if (
      responseId
      && !playback.startedResponses.has(responseId)
      && !playback.startTimers.has(responseId)
    ) {
      const checkStarted = () => {
        const current = playbackRef.current
        if (!current.startTimers.has(responseId)) return
        if (context.state !== 'running' || context.currentTime + 0.005 < start) {
          const timer = setTimeout(checkStarted, 20)
          current.startTimers.set(responseId, timer)
          return
        }
        confirmTrackedPlaybackStart(
          current,
          responseId,
          id => sendPlaybackEvent(GatewayClientEvent.PLAYBACK_STARTED, id),
        )
      }
      const delay = Math.max(0, (start - context.currentTime) * 1000)
      const timer = setTimeout(checkStarted, delay)
      playback.startTimers.set(responseId, timer)
    }
    source.onended = () => {
      const current = playbackRef.current
      current.sources = current.sources.filter(item => item !== source)
      if (responseId && current.sourceCounts.has(responseId)) {
        // Web Audio can keep rendering while Electron throttles renderer
        // timers. Reaching onended proves that this tracked source traversed
        // the playback timeline, so it is a safe fallback acknowledgement.
        confirmTrackedPlaybackStart(
          current,
          responseId,
          id => sendPlaybackEvent(GatewayClientEvent.PLAYBACK_STARTED, id),
        )
        current.sourceCounts.set(
          responseId,
          Math.max(0, (current.sourceCounts.get(responseId) || 0) - 1),
        )
        finishPlaybackIfReady(responseId)
      }
    }
    try {
      source.start(start)
    } catch (reason) {
      playback.sources = playback.sources.filter(item => item !== source)
      failPlayback(responseId, reason)
    }
  }, [failPlayback, finishPlaybackIfReady, sendPlaybackEvent])

  useEffect(() => {
    if (!suspended) return
    dispatchClientState({
      type: GatewayServerEvent.VOICE_STATE,
      state: 'idle',
    })
    dispatchClientState({
      type: GatewayServerEvent.VOICE_CONNECTION,
      state: 'hidden',
    })
    setInputReady(false)
    setError('')
    setVisualError(false)
  }, [suspended])

  useEffect(() => {
    const mutedResponses = mutedPlaybackResponses.current
    const handleEvent = event => {
      dispatchClientState(event)
      if (event.type === GatewayServerEvent.VOICE_READY && event.inputSampleRate) {
        inputSampleRate.current = event.inputSampleRate
        hasConnectedRef.current = true
        setError('')
        setVisualError(false)
        flushPendingManualInputs()
      }
      if (event.type === GatewayServerEvent.VOICE_CONNECTION) {
        if (event.state === 'connected') {
          hasConnectedRef.current = true
          setError('')
          setVisualError(false)
          flushPendingManualInputs()
        } else if (event.state === 'unavailable') {
          setError(event.message || t('语音前台连接异常，正在重试'))
          setVisualError(true)
        }
      }
      if (event.type === GatewayServerEvent.TURN_STARTED) {
        currentTurnId.current = event.turnId || ''
        if (
          manualInputPendingRef.current
          && String(event.turnId || '').startsWith('text_')
        ) {
          manualInputTurnRef.current = event.turnId
        }
      }
      if (releasesManualInputGuard(event, manualInputTurnRef.current)) {
        releaseManualInputGuard()
      }
      if (
        event.type === GatewayServerEvent.VOICE_STATE
        && acceptsVoiceState(event, currentTurnId.current)
        && event.state === 'listening'
      ) {
        stopPlayback('user_interruption')
      }
      if (event.type === GatewayServerEvent.PLAYBACK_CLEAR) {
        stopPlayback(event.reason || '')
      }
      if (event.type === GatewayServerEvent.AUDIO_DELTA) {
        if (outputMutedRef.current || !audioRef.current) {
          consumeMutedAudio(event.responseId)
        } else {
          play(event.audio, event.sampleRate, event.responseId)
        }
      }
      if (event.type === GatewayServerEvent.AUDIO_DONE) {
        if (mutedPlaybackResponses.current.has(event.responseId)) {
          finishMutedAudio(event.responseId)
        } else {
          markAudioDone(event.responseId)
        }
      }
      if (event.type === GatewayServerEvent.ERROR) setError(event.message)
      eventRef.current?.(event)
    }
    const client = new GatewayClient({
      url: socketUrl(sessionId),
      createSocket: url => new WebSocket(url),
      clientType,
      clientLabel,
      clientInstanceId: clientInstanceId.current,
      capabilities: gatewayClientCapabilities({ clientType }),
      locale: navigator.language,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      configure: () => {
        const mode = realtimeClientMode({
          enabled: enabledRef.current,
          inputReady: inputReadyRef.current,
          inputOnlyMute,
          wakeWordOnly: wakeWordOnlyRef.current,
        })
        return {
          type: GatewayClientEvent.CONNECT,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          locale: navigator.language,
          voiceEnabled: mode.outputEnabled,
          inputEnabled: mode.inputEnabled,
          outputEnabled: mode.outputEnabled,
          textOnly: mode.textOnly,
          wakeWordOnly: wakeWordOnlyRef.current,
          clientType,
          clientLabel,
          inputCapabilities: clientInputCapabilities(clientType),
          clientStates: clientStatesSignature
            ? clientStatesSignature.split(',')
            : [],
          clientInstanceId: clientInstanceId.current,
          // Empty means "keep the server default front end".
          ...(realtimeProvider ? { provider: realtimeProvider } : {}),
        }
      },
      onEvent: handleEvent,
      onAction: event => clientActionRef.current?.(event),
      onRecovery: recovery => eventRef.current?.({
        type: 'session.recovered',
        ...recovery,
      }),
      onStatus: status => {
        if (status.state === 'connected') {
          setError('')
          setVisualError(false)
          const connectedEvent = { type: GatewayServerEvent.GATEWAY_CONNECTED }
          dispatchClientState(connectedEvent)
          eventRef.current?.(connectedEvent)
        } else if (status.state === 'unavailable') {
          dispatchClientState({
            type: GatewayServerEvent.VOICE_CONNECTION,
            state: 'unavailable',
          })
          setError(t('实时语音连接中断，正在重连'))
          setVisualError(true)
        } else if (status.state === 'disconnected') {
          releaseManualInputGuard()
          stopPlayback()
          const disconnectedEvent = {
          type: GatewayServerEvent.GATEWAY_DISCONNECTED,
        }
        dispatchClientState(disconnectedEvent)
          setError(t('实时语音连接中断，正在重连'))
          setVisualError(true)
          eventRef.current?.(disconnectedEvent)
        }
      }
    })
    socketRef.current = client
    setError('')
    dispatchClientState({
      type: GatewayServerEvent.VOICE_CONNECTION,
      state: 'connecting',
    })
    client.start()

    return () => {
      stopPlayback('connection_closed')
      client.stop()
      socketRef.current = null
      mutedResponses.clear()
      releaseManualInputGuard()
    }
  }, [
    clientLabel,
    clientStatesSignature,
    clientType,
    consumeMutedAudio,
    finishMutedAudio,
    inputOnlyMute,
    markAudioDone,
    play,
    realtimeProvider,
    releaseManualInputGuard,
    flushPendingManualInputs,
    sessionId,
    stopPlayback,
  ])

  useEffect(() => {
    if (outputMuted) stopPlayback()
  }, [outputMuted, stopPlayback])

  useEffect(() => {
    pendingManualInputsRef.current = []
  }, [sessionId])

  useEffect(() => {
    if (!enabled || suspended) {
      inputReadyRef.current = false
      setInputReady(false)
      sendSocketEvent(microphoneControlEvent({
        enabled: false,
        inputOnlyMute,
        wakeWordOnly: false,
      }))
      return undefined
    }

    let disposed = false
    inputReadyRef.current = false
    const setCaptureReady = ready => {
      if (disposed) return
      const changed = inputReadyRef.current !== ready
      inputReadyRef.current = ready
      setInputReady(ready)
      if (!changed) return
      sendSocketEvent(microphoneControlEvent({
        enabled: ready,
        inputOnlyMute,
        wakeWordOnly: ready && wakeWordOnlyRef.current,
      }))
    }
    const failInput = reason => {
      const message = reason?.message || String(reason || t('无法打开麦克风'))
      inputReadyRef.current = false
      setInputReady(false)
      sendSocketEvent(microphoneControlEvent({
        enabled: false,
        inputOnlyMute,
        wakeWordOnly: false,
      }))
      setError(message)
      setVisualError(true)
      inputErrorRef.current?.(message)
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      failInput(t('无法打开麦克风'))
      return undefined
    }
    const unsupportedInput = message => {
      const error = new Error(message)
      error.name = 'NotSupportedError'
      return error
    }
    const capture = createMicrophoneCaptureLifecycle({
      mediaDevices: navigator.mediaDevices,
      acquire: async () => {
        if (!activateAudio()) {
          throw unsupportedInput(t('当前浏览器不支持实时语音播放'))
        }
        const context = audioRef.current
        if (!context) throw unsupportedInput(t('无法初始化实时语音播放'))
        if (context.state === 'suspended') await context.resume()
        const media = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        })
        let source
        let processor
        try {
          source = context.createMediaStreamSource(media)
          processor = context.createScriptProcessor(2048, 1, 1)
          processor.onaudioprocess = event => {
            const samples = microphoneSamplesDuringManualInput(
              event.inputBuffer.getChannelData(0),
              manualInputPendingRef.current,
            )
            if (wakeWordOnlyRef.current) {
              const wakeAudio = resample(samples, context.sampleRate, 16_000)
              wakeWordAudioRef.current?.(pcmBase64(wakeAudio), 16_000)
              return
            }
            const socket = socketRef.current
            if (socket?.readyState !== WebSocket.OPEN) return
            const audio = resample(
              samples,
              context.sampleRate,
              inputSampleRate.current,
            )
            socket.send({
              type: GatewayClientEvent.AUDIO_APPEND,
              audio: pcmBase64(audio),
            })
          }
          source.connect(processor)
          processor.connect(context.destination)
          return {
            media,
            track: media.getAudioTracks()[0],
            close() {
              media.getTracks().forEach(track => track.stop())
              processor?.disconnect()
              source?.disconnect()
            },
          }
        } catch (error) {
          media.getTracks().forEach(track => track.stop())
          processor?.disconnect()
          source?.disconnect()
          throw error
        }
      },
      onState: captureState => {
        if (captureState.state === 'ready') {
          setError('')
          setVisualError(false)
          setCaptureReady(true)
          return
        }
        setCaptureReady(false)
        if (captureState.error && captureState.recoverable) {
          setError(captureState.state === 'unavailable'
            ? t('未检测到可用麦克风，连接设备后会自动恢复')
            : t('正在切换麦克风'))
          setVisualError(true)
        }
      },
      onFatalError: failInput,
    })
    capture.start()

    return () => {
      disposed = true
      inputReadyRef.current = false
      setInputReady(false)
      capture.stop()
    }
  }, [
    activateAudio,
    enabled,
    inputOnlyMute,
    sendSocketEvent,
    sessionId,
    suspended,
  ])

  useEffect(() => {
    if (!enabled || suspended || !inputReadyRef.current) return
    sendSocketEvent(microphoneControlEvent({
      enabled: true,
      inputOnlyMute,
      wakeWordOnly,
    }))
  }, [enabled, inputOnlyMute, sendSocketEvent, suspended, wakeWordOnly])

  useEffect(() => {
    if (!suspended) return
    const audio = audioRef.current
    audioRef.current = null
    audio?.close()
  }, [suspended])

  useEffect(() => () => {
    audioRef.current?.close()
    audioRef.current = null
  }, [])

  const interrupt = () => {
    stopPlayback('user_interruption')
    sendSocketEvent({ type: 'interrupt' })
  }

  // 桌面唤起（快捷键/托盘）时显式唤醒 Gateway：唤醒词开启时 socket 在休眠
  // 期间保持连接，不会重发 connect，需要专门的事件恢复前台语音连接。
  const wake = useCallback(() => (
    sendSocketEvent({ type: GatewayClientEvent.WAKE })
  ), [sendSocketEvent])

  const publishClientEvent = useCallback((name, data = {}, deliveryHint) => (
    sendSocketEvent({
      type: GatewayClientProtocolEvent.CLIENT_EVENT_PUBLISH,
      event_id: createGatewayProtocolEventId('client'),
      name,
      data,
      ...(deliveryHint ? { delivery_hint: deliveryHint } : {}),
    })
  ), [sendSocketEvent])

  const requestGateway = useCallback((type, payload = {}) => {
    const client = socketRef.current
    if (!client?.request) {
      return Promise.reject(Object.assign(new Error('Gateway 尚未连接'), {
        code: 'client_not_ready',
      }))
    }
    return client.request(type, payload)
  }, [])
  const listTasks = useCallback(options => requestGateway(
    GatewayClientProtocolEvent.TASK_LIST,
    options,
  ).then(result => result.tasks), [requestGateway])
  const getTask = useCallback(taskId => requestGateway(
    GatewayClientProtocolEvent.TASK_GET,
    { task_id: taskId },
  ).then(result => result.task), [requestGateway])
  const cancelTask = useCallback(taskId => requestGateway(
    GatewayClientProtocolEvent.TASK_CANCEL,
    { task_id: taskId },
  ).then(result => result.task), [requestGateway])
  const respondPermission = useCallback((permissionId, decision) => requestGateway(
    GatewayClientProtocolEvent.PERMISSION_RESPOND,
    { permission_id: permissionId, decision },
  ).then(result => result.permission), [requestGateway])
  const conversationHistory = useCallback(() => requestGateway(
    GatewayClientProtocolEvent.CONVERSATION_HISTORY,
  ).then(result => result.messages), [requestGateway])

  const sendInput = useCallback(parts => {
    holdManualInputGuard()
    const event = {
      type: GatewayClientEvent.INPUT_MESSAGE,
      parts,
    }
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      if (sendSocketEvent(event)) return true
      releaseManualInputGuard()
      return false
    }
    if (hasConnectedRef.current) {
      pendingManualInputsRef.current.push(event)
      return true
    }
    releaseManualInputGuard()
    return false
  }, [holdManualInputGuard, releaseManualInputGuard, sendSocketEvent])

  return {
    state,
    visualState: visualVoiceState(state),
    inputReady,
    error,
    visualError,
    connectionState,
    wakeWordActive,
    ownership,
    activateAudio,
    interrupt,
    wake,
    publishClientEvent,
    sendInput,
    listTasks,
    getTask,
    cancelTask,
    respondPermission,
    conversationHistory,
  }
}
