import { useCallback, useEffect, useRef, useState } from 'react'
import {
  GatewayClientEvent,
  GatewayServerEvent,
} from '../../shared/realtime-events.mjs'
import { decodePcm, pcmBase64, resample } from './audio.js'
import { confirmTrackedPlaybackStart } from './playback-lifecycle.js'
import { t } from './i18n.js'
import { textMessageEvent } from './text-input.js'

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

export function visualVoiceState(state, inputActive, enabled) {
  return enabled && inputActive ? 'listening' : state
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

export function textOutputConnectionCapabilities({
  enabled,
  inputReady,
  wakeWordOnly = false,
} = {}) {
  return {
    inputEnabled: shouldAdvertiseVoice(enabled, inputReady) && !wakeWordOnly,
    outputEnabled: true,
  }
}

export function queuedTextOwnershipAction(event, hasPendingText) {
  if (
    !hasPendingText
    || event?.type !== GatewayServerEvent.VOICE_OWNERSHIP
  ) return 'none'
  if (event.state === 'active') return 'send'
  if (event.state === 'busy') return 'fail'
  return 'wait'
}

export function textOutputReleaseAction({ temporaryLease, enabled }) {
  return temporaryLease && enabled !== true
    ? 'mute-and-wait-for-ownership'
    : 'clear'
}

export function textSendResultAction(sent) {
  return sent === true ? 'wait-for-reply' : 'cleanup'
}

export function shouldCleanupTextReplyOnError({
  pending,
  temporaryLease,
  replyActive,
} = {}) {
  return Boolean(pending || temporaryLease || replyActive)
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
  const [inputActive, setInputActive] = useState(false)
  const [inputReady, setInputReady] = useState(false)
  const [error, setError] = useState('')
  const [visualError, setVisualError] = useState(false)
  const [gatewayConnected, setGatewayConnected] = useState(false)
  const [textOutputActive, setTextOutputActive] = useState(false)
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
  const audioRef = useRef(null)
  const levelElementRef = useRef(null)
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
  const ownershipRef = useRef(ownership)
  const pendingTextEventRef = useRef(null)
  const pendingTextClaimTimerRef = useRef(null)
  const sentTextRef = useRef('')
  const textReplyActiveRef = useRef(false)
  const textOutputLeaseRef = useRef(false)
  const textOutputReleasingRef = useRef(false)
  const textOutputTurnRef = useRef('')
  const textOutputResponseRef = useRef('')
  const mutedPlaybackResponses = useRef(new Set())
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
  ownershipRef.current = ownership

  const setAudioLevel = useCallback(value => {
    levelElementRef.current?.style.setProperty('--level', String(value))
  }, [])

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
    socket.send(JSON.stringify(event))
    return true
  }, [])

  const clearTextOutputState = useCallback(() => {
    clearTimeout(pendingTextClaimTimerRef.current)
    pendingTextClaimTimerRef.current = null
    pendingTextEventRef.current = null
    sentTextRef.current = ''
    textReplyActiveRef.current = false
    textOutputLeaseRef.current = false
    textOutputReleasingRef.current = false
    textOutputTurnRef.current = ''
    textOutputResponseRef.current = ''
    setTextOutputActive(false)
  }, [])

  const releaseTextOutput = useCallback(() => {
    const releaseAction = textOutputReleaseAction({
      temporaryLease: Boolean(
        textOutputLeaseRef.current || pendingTextEventRef.current,
      ),
      enabled: enabledRef.current,
    })
    clearTimeout(pendingTextClaimTimerRef.current)
    pendingTextClaimTimerRef.current = null
    pendingTextEventRef.current = null
    sentTextRef.current = ''
    textReplyActiveRef.current = false
    textOutputLeaseRef.current = false
    textOutputTurnRef.current = ''
    textOutputResponseRef.current = ''
    if (releaseAction === 'mute-and-wait-for-ownership') {
      textOutputReleasingRef.current = true
      ownershipRef.current = {
        ...ownershipRef.current,
        state: 'releasing',
      }
      setTextOutputActive(true)
      if (sendSocketEvent({ type: GatewayClientEvent.MUTE })) return
    }
    textOutputReleasingRef.current = false
    setTextOutputActive(false)
  }, [sendSocketEvent])

  const connectionEvent = useCallback(({ inputEnabled, outputEnabled }) => ({
    type: GatewayClientEvent.CONNECT,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: navigator.language,
    voiceEnabled: outputEnabled,
    inputEnabled,
    outputEnabled,
    wakeWordOnly: wakeWordOnlyRef.current,
    clientType,
    clientLabel,
    clientStates: clientStatesSignature
      ? clientStatesSignature.split(',')
      : [],
    clientInstanceId: clientInstanceId.current,
    takeover,
    // Empty means "keep the server default front end".
    ...(realtimeProvider ? { provider: realtimeProvider } : {}),
  }), [
    clientLabel,
    clientStatesSignature,
    clientType,
    realtimeProvider,
    takeover,
  ])

  const sendText = useCallback(text => {
    const event = textMessageEvent(text)
    if (!event || !activateAudio()) return false
    if (ownershipRef.current.state === 'busy') return false
    const capabilities = textOutputConnectionCapabilities({
      enabled: enabledRef.current,
      inputReady: inputReadyRef.current,
      wakeWordOnly: wakeWordOnlyRef.current,
    })
    if (ownershipRef.current.state === 'active') {
      sentTextRef.current = event.text
      textReplyActiveRef.current = true
      textOutputLeaseRef.current = !capabilities.inputEnabled
      setTextOutputActive(true)
      const sent = sendSocketEvent(event)
      if (textSendResultAction(sent) === 'wait-for-reply') return true
      releaseTextOutput()
      return false
    }
    pendingTextEventRef.current = event
    textReplyActiveRef.current = true
    setTextOutputActive(true)
    clearTimeout(pendingTextClaimTimerRef.current)
    pendingTextClaimTimerRef.current = setTimeout(() => {
      if (pendingTextEventRef.current !== event) return
      releaseTextOutput()
      eventRef.current?.({
        type: 'text.send.failed',
        message: t('无法获取语音输出，请重试'),
      })
    }, 5000)
    if (sendSocketEvent(connectionEvent({
      ...capabilities,
    }))) return true
    clearTextOutputState()
    return false
  }, [
    activateAudio,
    clearTextOutputState,
    connectionEvent,
    releaseTextOutput,
    sendSocketEvent,
  ])

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
    if (textReplyActiveRef.current || textOutputLeaseRef.current) {
      releaseTextOutput()
    }
  }, [releaseTextOutput, sendPlaybackEvent])

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
    if (textOutputResponseRef.current === responseId) releaseTextOutput()
  }, [releaseTextOutput, sendPlaybackEvent])

  const markAudioDone = useCallback(responseId => {
    if (!responseId) return
    const playback = playbackRef.current
    if (playback.failedResponses.delete(responseId)) return
    playback.doneResponses.add(responseId)
    finishPlaybackIfReady(responseId)
    if (
      textOutputResponseRef.current === responseId
      && !playback.startTimers.has(responseId)
      && !playback.startedResponses.has(responseId)
      && (playback.sourceCounts.get(responseId) || 0) === 0
    ) releaseTextOutput()
  }, [finishPlaybackIfReady, releaseTextOutput])

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
      if (textOutputResponseRef.current === responseId) releaseTextOutput()
    }
    setError(reason?.message || String(reason || t('语音播放失败')))
    setVisualError(true)
  }, [releaseTextOutput, sendPlaybackEvent])

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
      setInputActive(false)
      setInputReady(false)
      setAudioLevel(0)
      setError('')
      setVisualError(false)
      setGatewayConnected(false)
      setConnectionState('hidden')
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
        setGatewayConnected(true)
        setConnectionState('connecting')
        eventRef.current?.({ type: GatewayServerEvent.GATEWAY_CONNECTED })
        const inputEnabled = shouldAdvertiseVoice(
          enabledRef.current,
          inputReadyRef.current,
        ) && !wakeWordOnlyRef.current
        const outputEnabled = inputOnlyMute || inputEnabled
        socket.send(JSON.stringify(connectionEvent({
          inputEnabled,
          outputEnabled,
        })))
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
          setConnectionState('connected')
          setError('')
          setVisualError(false)
        }
        if (event.type === GatewayServerEvent.VOICE_CONNECTION) {
          setConnectionState(event.state || 'connecting')
          if (event.state === 'connected') {
            setError('')
            setVisualError(false)
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
          const nextOwnership = {
            state: event.state || 'available',
            holder: event.holder || null,
          }
          ownershipRef.current = nextOwnership
          setOwnership(nextOwnership)
          if (
            textOutputReleasingRef.current
            && event.state !== 'active'
          ) clearTextOutputState()
          const textOwnershipAction = queuedTextOwnershipAction(
            event,
            Boolean(pendingTextEventRef.current),
          )
          if (textOwnershipAction === 'send') {
            const pending = pendingTextEventRef.current
            clearTimeout(pendingTextClaimTimerRef.current)
            pendingTextClaimTimerRef.current = null
            pendingTextEventRef.current = null
            sentTextRef.current = pending.text
            textOutputLeaseRef.current = !shouldAdvertiseVoice(
              enabledRef.current,
              inputReadyRef.current,
            )
            socket.send(JSON.stringify(pending))
          } else if (textOwnershipAction === 'fail') {
            clearTextOutputState()
            eventRef.current?.({
              type: 'text.send.failed',
              message: t('其他入口正在使用语音，请稍后重试'),
            })
          }
        }
        if (event.type === GatewayServerEvent.VOICE_DEACTIVATED) {
          const nextOwnership = {
            state: 'busy',
            holder: event.holder || null,
          }
          ownershipRef.current = nextOwnership
          setOwnership(nextOwnership)
          clearTextOutputState()
        }
        if (event.type === GatewayServerEvent.TURN_STARTED) {
          currentTurnId.current = event.turnId || ''
        }
        if (
          event.type === GatewayServerEvent.RESPONSE_STARTED
          && textReplyActiveRef.current
          && event.turnId
          && event.turnId === textOutputTurnRef.current
        ) textOutputResponseRef.current = event.responseId || ''
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
          if (outputMutedRef.current) {
            consumeMutedAudio(event.responseId)
          } else {
            play(event.audio, event.sampleRate, event.responseId)
          }
        }
        if (event.type === GatewayServerEvent.AUDIO_DONE) {
          if (
            textReplyActiveRef.current
            && event.turnId
            && event.turnId === textOutputTurnRef.current
          ) textOutputResponseRef.current = event.responseId || ''
          if (mutedPlaybackResponses.current.has(event.responseId)) {
            finishMutedAudio(event.responseId)
          } else {
            markAudioDone(event.responseId)
          }
        }
        if (
          event.type === GatewayServerEvent.TRANSCRIPT_FINAL
          && event.role === 'user'
          && sentTextRef.current
          && String(event.content || '').trim() === sentTextRef.current
        ) textOutputTurnRef.current = event.turnId || ''
        if (event.type === GatewayServerEvent.ERROR) {
          setError(event.message)
          if (shouldCleanupTextReplyOnError({
            pending: pendingTextEventRef.current,
            temporaryLease: textOutputLeaseRef.current,
            replyActive: textReplyActiveRef.current,
          })) {
            releaseTextOutput()
          }
        }
        eventRef.current?.(event)
      }
      socket.onerror = () => {
        if (!disposed) {
          clearTextOutputState()
          setGatewayConnected(false)
          setConnectionState('unavailable')
          setError(t('实时语音连接中断，正在重连'))
          setVisualError(true)
        }
      }
      socket.onclose = () => {
        if (socketRef.current === socket) socketRef.current = null
        if (disposed) return
        clearTextOutputState()
        setGatewayConnected(false)
        stopPlayback()
        setState('idle')
        setConnectionState('unavailable')
        setError(t('实时语音连接中断，正在重连'))
        setVisualError(true)
        eventRef.current?.({ type: GatewayServerEvent.GATEWAY_DISCONNECTED })
        reconnectTimer = setTimeout(connect, reconnectDelay)
        reconnectDelay = Math.min(5000, reconnectDelay * 2)
      }
    }
    setError('')
    setGatewayConnected(false)
    setConnectionState('connecting')
    connect()

    return () => {
      disposed = true
      clearTimeout(reconnectTimer)
      stopPlayback(suspended ? 'desktop_hidden' : 'connection_closed')
      socketRef.current?.close()
      socketRef.current = null
      clearTextOutputState()
      setGatewayConnected(false)
      mutedResponses.clear()
    }
  }, [
    clearTextOutputState,
    connectionEvent,
    consumeMutedAudio,
    finishMutedAudio,
    inputOnlyMute,
    markAudioDone,
    play,
    releaseTextOutput,
    sessionId,
    setAudioLevel,
    stopPlayback,
    suspended,
  ])

  useEffect(() => {
    if (outputMuted) stopPlayback()
  }, [outputMuted, stopPlayback])

  useEffect(() => {
    if (!enabled || suspended) {
      inputReadyRef.current = false
      setInputReady(false)
      sendSocketEvent(microphoneControlEvent({
        enabled: false,
        inputOnlyMute,
        wakeWordOnly: false,
      }))
      setAudioLevel(0)
      setInputActive(false)
      return undefined
    }

    let disposed = false
    let media
    let source
    let processor
    let analyser
    let animation
    let visualInputActive = false
    let lastVoiceAt = 0
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
      setAudioLevel(0)
      setInputActive(false)
      media?.getTracks().forEach(track => track.stop())
      processor?.disconnect()
      source?.disconnect()
      analyser?.disconnect()
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
        analyser = context.createAnalyser()
        analyser.fftSize = 512
        source.connect(analyser)
        processor = context.createScriptProcessor(2048, 1, 1)
        processor.onaudioprocess = event => {
          const socket = socketRef.current
          if (socket?.readyState !== WebSocket.OPEN) return
          const audio = resample(
            event.inputBuffer.getChannelData(0),
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
        const samples = new Float32Array(analyser.fftSize)
        const tick = () => {
          analyser.getFloatTimeDomainData(samples)
          const power = samples.reduce((sum, value) => sum + value * value, 0)
          const level = Math.min(1, Math.sqrt(power / samples.length) / 0.18)
          setAudioLevel(level)
          const now = performance.now()
          if (level >= 0.075) {
            lastVoiceAt = now
            if (!visualInputActive) {
              visualInputActive = true
              setInputActive(true)
            }
          } else if (visualInputActive && now - lastVoiceAt >= 140) {
            visualInputActive = false
            setInputActive(false)
          }
          animation = requestAnimationFrame(tick)
        }
        tick()
      } catch (reason) {
        if (!disposed) failInput(reason)
      }
    }
    startAudio()

    return () => {
      disposed = true
      inputReadyRef.current = false
      setInputReady(false)
      cancelAnimationFrame(animation)
      setInputActive(false)
      media?.getTracks().forEach(track => track.stop())
      processor?.disconnect()
      source?.disconnect()
      analyser?.disconnect()
    }
  }, [
    activateAudio,
    enabled,
    inputOnlyMute,
    wakeWordOnly,
    sendSocketEvent,
    sessionId,
    setAudioLevel,
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

  return {
    state,
    visualState: visualVoiceState(state, inputActive, enabled && !suspended),
    inputReady,
    error,
    visualError,
    gatewayConnected,
    textOutputActive,
    connectionState,
    wakeWordActive,
    ownership,
    levelElementRef,
    activateAudio,
    sendText,
    interrupt,
    wake,
  }
}
