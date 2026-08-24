import { useCallback, useEffect, useRef, useState } from 'react'
import {
  GatewayClientEvent,
  GatewayServerEvent,
} from '../../shared/realtime-events.mjs'
import { clientInputCapabilities } from '../../shared/client-input-capabilities.mjs'
import { decodePcm, pcmBase64, resample } from './audio.js'
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
  return (
    !event.turnId
    || event.turnId === currentTurnId
    || event.origin !== 'model'
  )
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
  takeover = false,
} = {}) {
  if (wakeWordOnly) return { type: GatewayClientEvent.SLEEP }
  if (inputOnlyMute) {
    return enabled
      ? { type: GatewayClientEvent.INPUT_UNMUTE, takeover }
      : { type: GatewayClientEvent.INPUT_MUTE }
  }
  return enabled
    ? { type: GatewayClientEvent.UNMUTE, takeover }
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
  takeover = false,
  realtimeProvider = '',
  onEvent,
  onInputError,
}) {
  const [state, setState] = useState('idle')
  const [inputReady, setInputReady] = useState(false)
  const [error, setError] = useState('')
  const [visualError, setVisualError] = useState(false)
  const [connectionState, setConnectionState] = useState('connecting')
  const [wakeWordActive, setWakeWordActive] = useState(false)
  const [ownership, setOwnership] = useState({
    state: 'available',
    holder: null,
  })
  const eventRef = useRef(onEvent)
  const inputErrorRef = useRef(onInputError)
  const wakeWordOnlyRef = useRef(wakeWordOnly)
  const socketRef = useRef(null)
  const connectionStateRef = useRef('connecting')
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
    startedResponses: new Set(),
    sourceCounts: new Map(),
    doneResponses: new Set(),
    failedResponses: new Set(),
  })
  eventRef.current = onEvent
  inputErrorRef.current = onInputError
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
      socket.send(JSON.stringify(event))
      return true
    } catch {
      return false
    }
  }, [])

  const setRealtimeConnectionState = useCallback(next => {
    connectionStateRef.current = next
    if (next === 'connected') hasConnectedRef.current = true
    setConnectionState(next)
  }, [])

  const flushPendingManualInputs = useCallback(() => {
    if (connectionStateRef.current !== 'connected') return
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
      ...playback.startedResponses,
      ...playback.sourceCounts.keys(),
    ])
    for (const timer of playback.startTimers.values()) {
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
  }, [finishPlaybackIfReady])

  const failPlayback = useCallback((responseId, reason) => {
    const playback = playbackRef.current
    if (responseId && !playback.failedResponses.has(responseId)) {
      playback.failedResponses.add(responseId)
      const timer = playback.startTimers.get(responseId)
      if (timer !== undefined) clearTimeout(timer)
      playback.startTimers.delete(responseId)
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
    if (suspended) {
      setState('idle')
      setInputReady(false)
      setError('')
      setVisualError(false)
      setRealtimeConnectionState('hidden')
      return undefined
    }
    let disposed = false
    let reconnectTimer
    let reconnectDelay = 500
    const mutedResponses = mutedPlaybackResponses.current
    const connect = () => {
      if (disposed) return
      const socket = new WebSocket(socketUrl(sessionId))
      socketRef.current = socket
      socket.onopen = () => {
        reconnectDelay = 500
        setError('')
        setVisualError(false)
        setRealtimeConnectionState('connecting')
        eventRef.current?.({ type: GatewayServerEvent.GATEWAY_CONNECTED })
        const mode = realtimeClientMode({
          enabled: enabledRef.current,
          inputReady: inputReadyRef.current,
          inputOnlyMute,
          wakeWordOnly: wakeWordOnlyRef.current,
        })
        socket.send(JSON.stringify({
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
          takeover,
          // Empty means "keep the server default front end".
          ...(realtimeProvider ? { provider: realtimeProvider } : {}),
        }))
      }
      socket.onmessage = message => {
        let event
        try {
          event = JSON.parse(message.data)
        } catch {
          return
        }
        if (event.type === GatewayServerEvent.VOICE_READY && event.inputSampleRate) {
          inputSampleRate.current = event.inputSampleRate
          setRealtimeConnectionState('connected')
          setError('')
          setVisualError(false)
          flushPendingManualInputs()
        }
        if (event.type === GatewayServerEvent.VOICE_CONNECTION) {
          setRealtimeConnectionState(event.state || 'connecting')
          if (event.state === 'connected') {
            setError('')
            setVisualError(false)
            flushPendingManualInputs()
          } else if (event.state === 'unavailable') {
            setError(event.message || t('语音前台连接异常，正在重试'))
            setVisualError(true)
          }
        }
        if (event.type === GatewayServerEvent.VOICE_SLEEP) {
          if (event.state === 'enabled') {
            setWakeWordActive(true)
          } else if (event.state === 'disabled') {
            setWakeWordActive(false)
          }
        }
        if (event.type === GatewayServerEvent.VOICE_OWNERSHIP) {
          setOwnership({
            state: event.state || 'available',
            holder: event.holder || null,
          })
        }
        if (event.type === GatewayServerEvent.VOICE_DEACTIVATED) {
          setOwnership({
            state: 'busy',
            holder: event.holder || null,
          })
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
        if (event.type === GatewayServerEvent.VOICE_STATE) {
          if (acceptsVoiceState(event, currentTurnId.current)) {
            setState(event.state)
            if (event.state === 'listening') {
              stopPlayback('user_interruption')
            }
          }
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
      socket.onerror = () => {
        if (!disposed) {
          setRealtimeConnectionState('unavailable')
          setError(t('实时语音连接中断，正在重连'))
          setVisualError(true)
        }
      }
      socket.onclose = () => {
        if (socketRef.current === socket) socketRef.current = null
        if (disposed) return
        releaseManualInputGuard()
        stopPlayback()
        setState('idle')
        setRealtimeConnectionState('unavailable')
        setError(t('实时语音连接中断，正在重连'))
        setVisualError(true)
        eventRef.current?.({ type: GatewayServerEvent.GATEWAY_DISCONNECTED })
        reconnectTimer = setTimeout(connect, reconnectDelay)
        reconnectDelay = Math.min(5000, reconnectDelay * 2)
      }
    }
    setError('')
    setRealtimeConnectionState('connecting')
    connect()

    return () => {
      disposed = true
      clearTimeout(reconnectTimer)
      stopPlayback(suspended ? 'desktop_hidden' : 'connection_closed')
      socketRef.current?.close()
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
    suspended,
    setRealtimeConnectionState,
    takeover,
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
    let media
    let source
    let processor
    inputReadyRef.current = false
    const failInput = reason => {
      const message = reason?.message || String(reason || t('无法打开麦克风'))
      inputReadyRef.current = false
      setInputReady(false)
      sendSocketEvent(microphoneControlEvent({
        enabled: false,
        inputOnlyMute,
        wakeWordOnly: false,
      }))
      media?.getTracks().forEach(track => track.stop())
      processor?.disconnect()
      source?.disconnect()
      setError(message)
      setVisualError(true)
      inputErrorRef.current?.(message)
    }
    const startAudio = async () => {
      try {
        if (!activateAudio()) {
          failInput(t('当前浏览器不支持实时语音播放'))
          return
        }
        const context = audioRef.current
        if (!context) {
          failInput(t('无法初始化实时语音播放'))
          return
        }
        if (context.state === 'suspended') await context.resume()
        media = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        })
        if (disposed) return media.getTracks().forEach(track => track.stop())
        setVisualError(false)
        source = context.createMediaStreamSource(media)
        processor = context.createScriptProcessor(2048, 1, 1)
        processor.onaudioprocess = event => {
          const socket = socketRef.current
          if (socket?.readyState !== WebSocket.OPEN) return
          const samples = microphoneSamplesDuringManualInput(
            event.inputBuffer.getChannelData(0),
            manualInputPendingRef.current,
          )
          const audio = resample(
            samples,
            context.sampleRate,
            inputSampleRate.current,
          )
          socket.send(JSON.stringify({
            type: GatewayClientEvent.AUDIO_APPEND,
            audio: pcmBase64(audio),
          }))
        }
        source.connect(processor)
        processor.connect(context.destination)
        inputReadyRef.current = true
        setInputReady(true)
        sendSocketEvent(microphoneControlEvent({
          enabled: true,
          inputOnlyMute,
          wakeWordOnly,
          takeover,
        }))
      } catch (reason) {
        if (!disposed) failInput(reason)
      }
    }
    startAudio()

    return () => {
      disposed = true
      inputReadyRef.current = false
      setInputReady(false)
      media?.getTracks().forEach(track => track.stop())
      processor?.disconnect()
      source?.disconnect()
    }
  }, [
    activateAudio,
    enabled,
    inputOnlyMute,
    wakeWordOnly,
    sendSocketEvent,
    sessionId,
    suspended,
    takeover,
  ])

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
    sendInput,
  }
}
