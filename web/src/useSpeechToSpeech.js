import { useEffect, useRef, useState } from 'react'
import { decodePcm, pcmBase64, resample } from './audio.js'
import { browserTtsSupported, preferredChineseVoice } from './browserTts.js'

const INPUT_RATE = 16000
const DEFAULT_OUTPUT_RATE = 24000

function socketUrl() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const basePath = location.pathname.endsWith('/')
    ? location.pathname
    : location.pathname.replace(/[^/]*$/, '')
  return `${protocol}//${location.host}${basePath}api/speech-to-speech`
}

function base64Bytes(value) {
  const binary = atob(value)
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
  return bytes.buffer
}

function visualState(state, inputActive, enabled) {
  return enabled && inputActive ? 'listening' : state
}

export default function useSpeechToSpeech({
  sessionId,
  enabled,
  ttsMode = 'server',
  onEvent,
  onInputError,
}) {
  const [state, setState] = useState('idle')
  const [inputActive, setInputActive] = useState(false)
  const [error, setError] = useState('')
  const [visualError, setVisualError] = useState(false)
  const [connectionState, setConnectionState] = useState('idle')
  const eventRef = useRef(onEvent)
  const inputErrorRef = useRef(onInputError)
  const socketRef = useRef(null)
  const audioRef = useRef(null)
  const levelElementRef = useRef(null)
  const sessionReadyRef = useRef(false)
  const enabledRef = useRef(enabled)
  const inputReadyRef = useRef(false)
  const playbackRef = useRef({ cursor: 0, sources: [] })
  const browserSpeechRef = useRef(null)

  eventRef.current = onEvent
  inputErrorRef.current = onInputError
  enabledRef.current = enabled

  const setAudioLevel = value => {
    levelElementRef.current?.style.setProperty('--level', String(value))
  }

  const activateAudio = () => {
    const AudioContext = window.AudioContext || window.webkitAudioContext
    if (!AudioContext) {
      setError('当前浏览器不支持实时语音播放')
      setVisualError(true)
      return false
    }
    if (!audioRef.current || audioRef.current.state === 'closed') {
      audioRef.current = new AudioContext()
    }
    audioRef.current.resume().catch(reason => {
      setError(reason?.message || '语音播放没有成功启用，请再点一次开启语音')
      setVisualError(true)
    })
    return true
  }

  const sendSocketEvent = event => {
    const socket = socketRef.current
    if (socket?.readyState !== WebSocket.OPEN) return false
    socket.send(JSON.stringify(event))
    return true
  }

  const stopPlayback = () => {
    playbackRef.current.sources.forEach(source => {
      try {
        source.stop()
      } catch {
        // The source may already have ended.
      }
    })
    playbackRef.current = { cursor: 0, sources: [] }
    browserSpeechRef.current = null
    if (browserTtsSupported(window)) window.speechSynthesis.cancel()
    if (enabledRef.current) setState('idle')
  }

  const speakInBrowser = text => {
    const content = String(text || '').trim()
    if (!content) return
    if (!browserTtsSupported(window)) {
      setError('当前浏览器不支持内置语音合成，请切换到 MiMo TTS')
      setVisualError(true)
      return
    }
    stopPlayback()
    const utterance = new window.SpeechSynthesisUtterance(content)
    utterance.lang = 'zh-CN'
    utterance.rate = 1
    utterance.pitch = 1
    utterance.volume = 1
    const voice = preferredChineseVoice(window.speechSynthesis.getVoices())
    if (voice) utterance.voice = voice
    browserSpeechRef.current = utterance
    utterance.onstart = () => {
      if (browserSpeechRef.current === utterance && enabledRef.current) {
        setState('speaking')
      }
    }
    utterance.onend = () => {
      if (browserSpeechRef.current === utterance) {
        browserSpeechRef.current = null
        if (enabledRef.current) setState('idle')
      }
    }
    utterance.onerror = event => {
      if (browserSpeechRef.current !== utterance) return
      browserSpeechRef.current = null
      setState('idle')
      setError(event.error || '浏览器语音合成失败，请切换到 MiMo TTS')
      setVisualError(true)
    }
    window.speechSynthesis.speak(utterance)
  }

  const failInput = (reason, media, processor, source, analyser) => {
    const message = reason?.message || String(reason || '无法打开麦克风')
    inputReadyRef.current = false
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

  const playAudio = async event => {
    const context = audioRef.current
    if (!context || !event.audio) return
    try {
      if (context.state === 'suspended') await context.resume()
      let buffer
      if (event.format === 'pcm16' || event.format === 'pcm') {
        const samples = decodePcm(event.audio)
        buffer = context.createBuffer(
          1,
          samples.length,
          Number(event.sample_rate) || DEFAULT_OUTPUT_RATE,
        )
        buffer.copyToChannel(samples, 0)
      } else {
        buffer = await context.decodeAudioData(base64Bytes(event.audio).slice(0))
      }
      if (!enabledRef.current) return
      const source = context.createBufferSource()
      source.buffer = buffer
      source.connect(context.destination)
      const playback = playbackRef.current
      const start = Math.max(context.currentTime + 0.02, playback.cursor)
      playback.cursor = start + buffer.duration
      playback.sources.push(source)
      setState('speaking')
      source.onended = () => {
        const current = playbackRef.current
        current.sources = current.sources.filter(item => item !== source)
        if (current.sources.length === 0 && enabledRef.current) setState('idle')
      }
      source.start(start)
    } catch (reason) {
      setError(reason?.message || '语音播放失败')
      setVisualError(true)
    }
  }

  useEffect(() => {
    if (!enabled) {
      sessionReadyRef.current = false
      setConnectionState('idle')
      setInputActive(false)
      stopPlayback()
      return undefined
    }

    let disposed = false
    let reconnectTimer
    let reconnectDelay = 500
    const connect = () => {
      if (disposed) return
      const socket = new WebSocket(socketUrl())
      socketRef.current = socket
      sessionReadyRef.current = false
      setConnectionState('connecting')
      socket.onopen = () => {
        reconnectDelay = 500
        setError('')
        setVisualError(false)
      }
      socket.onmessage = message => {
        let event
        try {
          event = JSON.parse(message.data)
        } catch {
          return
        }
        if (event.type === 'server.ready') {
          sendSocketEvent({
            type: 'session.start',
            sample_rate: INPUT_RATE,
            tts_mode: ttsMode,
          })
        }
        if (event.type === 'session.ready') {
          sessionReadyRef.current = true
          setConnectionState('connected')
          setError('')
          setVisualError(false)
        }
        if (event.type === 'vad.speech_started') {
          stopPlayback()
          setState('listening')
        }
        if (event.type === 'pipeline.error') {
          setError('云端语音链路暂时不可用')
          setVisualError(true)
        }
        if (event.type === 'tts.started') {
          stopPlayback()
        }
        if (event.type === 'tts.chunk' || event.type === 'tts.completed') {
          if (ttsMode === 'server') void playAudio(event)
        }
        if (event.type === 'llm.completed' && ttsMode === 'browser') {
          speakInBrowser(event.text)
        }
        eventRef.current?.(event)
      }
      socket.onerror = () => {
        if (!disposed) {
          setConnectionState('unavailable')
          setError('语音服务连接中断，正在重连')
          setVisualError(true)
        }
      }
      socket.onclose = () => {
        if (socketRef.current === socket) socketRef.current = null
        sessionReadyRef.current = false
        if (disposed) return
        setConnectionState('unavailable')
        setState('idle')
        setError('语音服务连接中断，正在重连')
        setVisualError(true)
        reconnectTimer = setTimeout(connect, reconnectDelay)
        reconnectDelay = Math.min(5000, reconnectDelay * 2)
      }
    }
    connect()
    return () => {
      disposed = true
      clearTimeout(reconnectTimer)
      sessionReadyRef.current = false
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.close()
      }
      socketRef.current = null
      stopPlayback()
    }
  }, [enabled, sessionId, ttsMode])

  useEffect(() => {
    if (!enabled) {
      inputReadyRef.current = false
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

    const startAudio = async () => {
      try {
        if (!activateAudio()) {
          failInput('当前浏览器不支持实时语音播放', media, processor, source, analyser)
          return
        }
        const context = audioRef.current
        if (!context) {
          failInput('无法初始化实时语音播放', media, processor, source, analyser)
          return
        }
        if (context.state === 'suspended') await context.resume()
        media = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            // Automatic gain often lifts fans, distant voices and playback
            // leakage enough to look like foreground speech to a VAD.
            autoGainControl: false,
          },
        })
        if (disposed) {
          media.getTracks().forEach(track => track.stop())
          return
        }
        setVisualError(false)
        source = context.createMediaStreamSource(media)
        analyser = context.createAnalyser()
        analyser.fftSize = 512
        source.connect(analyser)
        processor = context.createScriptProcessor(2048, 1, 1)
        processor.onaudioprocess = event => {
          const socket = socketRef.current
          if (
            socket?.readyState !== WebSocket.OPEN
            || !sessionReadyRef.current
          ) return
          const audio = resample(
            event.inputBuffer.getChannelData(0),
            context.sampleRate,
            INPUT_RATE,
          )
          socket.send(JSON.stringify({
            type: 'audio.append',
            audio: pcmBase64(audio),
          }))
        }
        source.connect(processor)
        processor.connect(context.destination)
        inputReadyRef.current = true
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
        if (!disposed) failInput(reason, media, processor, source, analyser)
      }
    }
    startAudio()

    return () => {
      disposed = true
      inputReadyRef.current = false
      cancelAnimationFrame(animation)
      setInputActive(false)
      media?.getTracks().forEach(track => track.stop())
      processor?.disconnect()
      source?.disconnect()
      analyser?.disconnect()
    }
  }, [enabled, sessionId])

  useEffect(() => () => {
    audioRef.current?.close()
    audioRef.current = null
  }, [])

  return {
    state,
    visualState: visualState(state, inputActive, enabled),
    error,
    visualError,
    connectionState,
    levelElementRef,
    activateAudio,
    interrupt: stopPlayback,
  }
}
