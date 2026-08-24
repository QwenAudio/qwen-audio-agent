import { WebSocket, WebSocketServer } from 'ws'
import { chatStream } from '../agent.mjs'
import { appendToHistory, buildMessages, loadHistory } from '../context.mjs'
import { getMemoryForPrompt, readMemory, writeMemory } from '../memory.mjs'
import { getSoulPrompt } from '../souls.mjs'
import { loadCustomSkillCatalog } from '../tools/skill-manage.mjs'
import { CAR_AGENT_TOOL_NAME, DEFAULT_REALTIME_PROVIDER_ID, createRealtimeProvider, normalizeRealtimeProviderId } from './providers/index.mjs'

const PROGRESS_SPEECH_DELAY_MS = 250
const MEMORY_FALLBACK_DELAY_MS = 1200
const VOICE_CONTEXT_HISTORY_ROUNDS = 5
const TRANSCRIPT_STREAM_CHARS = 3
const TRANSCRIPT_STREAM_DELAY_MS = 28
const VOICE_THINKING_TIMEOUT_MS = 30000
const VOICE_AGENT_TOTAL_TIMEOUT_MS = 35000
const VOICE_AGENT_LLM_TIMEOUT_MS = 18000
const VOICE_AGENT_TOOL_TIMEOUT_MS = 15000

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload))
  }
}

function parseJson(raw) {
  try {
    return JSON.parse(raw.toString())
  } catch {
    return null
  }
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function splitTranscriptChunks(text) {
  const chars = Array.from(String(text || ''))
  const chunks = []
  for (let i = 0; i < chars.length; i += TRANSCRIPT_STREAM_CHARS) {
    chunks.push(chars.slice(i, i + TRANSCRIPT_STREAM_CHARS).join(''))
  }
  return chunks
}

function formatRecentHistory(messages) {
  const roleLabels = {
    system: '系统摘要',
    user: '用户',
    assistant: '助手',
  }

  return messages
    .filter(msg => ['system', 'user', 'assistant'].includes(msg.role) && msg.content)
    .map(msg => `${roleLabels[msg.role]}：${String(msg.content).slice(0, 400)}`)
    .join('\n')
}

function cleanMemoryValue(value) {
  return String(value || '')
    .replace(/^[，,。.!！？?\s]+/, '')
    .replace(/[，,。.!！？?\s]+$/, '')
    .slice(0, 80)
}

function inferDirectMemoryContent(transcript) {
  const text = String(transcript || '').replace(/\s+/g, '').replace(/[。.!！?？]+$/, '')
  if (!text) return ''

  let match = text.match(/^(?:记住|帮我记住)?我(?:的)?名字(?:是|叫)(.{1,24})$/)
  if (match) return `用户名字叫${cleanMemoryValue(match[1])}`

  match = text.match(/^(?:以后)?(?:叫我|称呼我)(.{1,24})$/)
  if (match) return `用户希望被称呼为${cleanMemoryValue(match[1])}`

  match = text.match(/^我喜欢(.{1,80})$/)
  if (match) return `用户喜欢${cleanMemoryValue(match[1])}`

  match = text.match(/^我(?:不喜欢|讨厌)(.{1,80})$/)
  if (match) return `用户不喜欢${cleanMemoryValue(match[1])}`

  match = text.match(/^我习惯(.{1,80})$/)
  if (match) return `用户习惯${cleanMemoryValue(match[1])}`

  match = text.match(/^我的(?:梦想|目标|愿望|理想)(?:是|为)(.{1,80})$/)
  if (match) return `用户的梦想或目标是${cleanMemoryValue(match[1])}`

  match = text.match(/^我(?:想|希望|打算)成为(.{1,80})$/)
  if (match) return `用户想成为${cleanMemoryValue(match[1])}`

  match = text.match(/^我(?:家|公司)(?:在|是)(.{1,80})$/)
  if (match) return `用户${text.startsWith('我家') ? '家' : '公司'}在${cleanMemoryValue(match[1])}`

  match = text.match(/^(?:记住|帮我记住|你要记得)(.{1,100})$/)
  if (match) return `用户希望记住：${cleanMemoryValue(match[1])}`

  return ''
}

async function buildVoiceContextPrompt(soul, clientId) {
  const parts = [
    '【当前灵魂设定】',
    getSoulPrompt(soul),
  ]
  const memoryText = await getMemoryForPrompt(clientId)
  if (memoryText) parts.push(memoryText)

  const customSkills = await loadCustomSkillCatalog(clientId)
  if (customSkills.length > 0) {
    parts.push(`【可用自定义技能】\n${customSkills.map(skill => `- ${skill.name}: ${skill.description}`).join('\n')}`)
  }

  const history = await loadHistory(clientId)
  const recentHistory = formatRecentHistory(buildMessages(history, VOICE_CONTEXT_HISTORY_ROUNDS))
  if (recentHistory) {
    parts.push(`【最近对话上下文】\n${recentHistory}`)
  }

  return parts.join('\n\n')
}

export function attachVoiceRealtime(server, { getVehicleState, applyAgentActions } = {}) {
  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname !== '/api/voice/realtime') return

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, url)
    })
  })

  wss.on('connection', (ws, req, url) => {
    const clientId = url.searchParams.get('clientId') || 'default'
    const config = {
      soul: '聊愈师',
      routeStrategy: 0,
      thinking: false,
      realtimeProviderId: DEFAULT_REALTIME_PROVIDER_ID,
      voiceContextPrompt: '',
    }
    let latestUserTranscript = ''
    let realtimeProvider = null
    let pendingAudio = []
    let routeFunctionPending = 0
    let responseHasAudio = false
    let progressStage = ''
    let progressSpeechQueue = Promise.resolve()
    let progressSpeechActive = 0
    let providerResponseActive = false
    let activeResponseId = ''
    let sessionEpoch = 0
    let currentState = 'idle'
    let thinkingTimeoutTimer = 0
    let providerConnectPromise = null
    const providerIdleResolvers = []
    const progressResponseIds = new Set()
    const functionCallResponseIds = new Set()
    const interruptedResponseIds = new Set()
    const assistantTranscriptBuffers = new Map()
    const suppressedSpeechTexts = new Set()
    const progressTimers = new Set()
    let suppressAnonymousInterruptedResponse = false
    let memoryFallbackTimer = 0

    const clearThinkingTimeout = () => {
      if (thinkingTimeoutTimer) {
        clearTimeout(thinkingTimeoutTimer)
        thinkingTimeoutTimer = 0
      }
    }

    const setState = (state) => {
      currentState = state
      clearThinkingTimeout()
      if (state === 'thinking') {
        const timeoutEpoch = sessionEpoch
        thinkingTimeoutTimer = setTimeout(() => {
          thinkingTimeoutTimer = 0
          if (timeoutEpoch !== sessionEpoch || currentState !== 'thinking') return
          sessionEpoch += 1
          latestUserTranscript = ''
          pendingAudio = []
          routeFunctionPending = 0
          progressStage = ''
          progressSpeechQueue = Promise.resolve()
          progressSpeechActive = 0
          responseHasAudio = false
          activeResponseId = ''
          progressResponseIds.clear()
          functionCallResponseIds.clear()
          interruptedResponseIds.clear()
          assistantTranscriptBuffers.clear()
          suppressedSpeechTexts.clear()
          suppressAnonymousInterruptedResponse = false
          markProviderIdle()
          clearProgressTimers()
          clearMemoryFallback()
          realtimeProvider?.close()
          realtimeProvider = null
          providerConnectPromise = null
          send(ws, { type: 'error', message: '语音处理超时，请再试一次' })
          setState('idle')
        }, VOICE_THINKING_TIMEOUT_MS)
      }
      send(ws, { type: 'voice_state', state, provider: config.realtimeProviderId })
    }

    const clearProgressTimers = () => {
      progressTimers.forEach(timer => clearTimeout(timer))
      progressTimers.clear()
    }

    const clearMemoryFallback = () => {
      if (memoryFallbackTimer) {
        clearTimeout(memoryFallbackTimer)
        memoryFallbackTimer = 0
      }
    }

    const markProviderIdle = () => {
      providerResponseActive = false
      while (providerIdleResolvers.length) providerIdleResolvers.shift()?.()
    }

    const maybeSetIdle = () => {
      if (routeFunctionPending === 0 && progressSpeechActive === 0 && !providerResponseActive) {
        setState('idle')
      }
    }

    const waitForProviderIdle = () => {
      if (!providerResponseActive) return Promise.resolve()
      return new Promise((resolve) => {
        let finish
        const timeout = setTimeout(() => finish(), 2000)
        finish = () => {
          clearTimeout(timeout)
          const index = providerIdleResolvers.indexOf(finish)
          if (index >= 0) providerIdleResolvers.splice(index, 1)
          resolve()
        }
        providerIdleResolvers.push(finish)
      })
    }

    const cancelActiveVoiceOutput = () => {
      const hasActiveOutput = (
        providerResponseActive
        || responseHasAudio
        || routeFunctionPending > 0
        || progressSpeechActive > 0
      )
      const shouldCancelRealtimeResponse = (
        providerResponseActive
        || responseHasAudio
        || progressSpeechActive > 0
      )

      send(ws, { type: 'playback.clear', reason: 'user_interruption' })
      if (!hasActiveOutput) return

      const interruptedResponseId = activeResponseId
      if (shouldCancelRealtimeResponse) {
        if (interruptedResponseId) {
          interruptedResponseIds.add(interruptedResponseId)
        } else {
          suppressAnonymousInterruptedResponse = true
        }
      }

      sessionEpoch += 1
      latestUserTranscript = ''
      routeFunctionPending = 0
      progressStage = ''
      progressSpeechQueue = Promise.resolve()
      progressSpeechActive = 0
      responseHasAudio = false
      activeResponseId = ''
      progressResponseIds.clear()
      functionCallResponseIds.clear()
      assistantTranscriptBuffers.clear()
      suppressedSpeechTexts.clear()
      markProviderIdle()
      clearProgressTimers()
      clearMemoryFallback()
      if (shouldCancelRealtimeResponse) {
        realtimeProvider?.cancelResponse()
      }
    }

    const responseIdFromEvent = (event) => event.response_id || event.response?.id || activeResponseId

    const normalizeSpeechText = (text) => String(text || '').replace(/[，。！？、\s]/g, '')

    const streamAssistantTranscript = async (content) => {
      const text = String(content || '').trim()
      if (!text) return

      for (const chunk of splitTranscriptChunks(text)) {
        if (ws.readyState !== WebSocket.OPEN) return
        send(ws, { type: 'transcript_delta', role: 'assistant', content: chunk })
        await wait(TRANSCRIPT_STREAM_DELAY_MS)
      }

      send(ws, { type: 'transcript', role: 'assistant', content: text })
    }

    const getAssistantTranscriptBuffer = (responseId) => {
      const key = responseId || 'unknown'
      if (!assistantTranscriptBuffers.has(key)) {
        assistantTranscriptBuffers.set(key, { deltas: '', transcript: '' })
      }
      return assistantTranscriptBuffers.get(key)
    }

    const flushAssistantTranscript = (responseId) => {
      const key = responseId || 'unknown'
      const buffer = assistantTranscriptBuffers.get(key)
      if (!buffer) return ''

      const content = String(buffer.transcript || buffer.deltas || '').trim()
      const normalizedContent = normalizeSpeechText(content)
      const shouldDrop = (
        progressResponseIds.has(responseId) ||
        functionCallResponseIds.has(responseId) ||
        interruptedResponseIds.has(responseId) ||
        suppressAnonymousInterruptedResponse ||
        progressSpeechActive > 0 ||
        suppressedSpeechTexts.has(normalizedContent)
      )

      if (content && !shouldDrop) {
        streamAssistantTranscript(content).catch(err => {
          console.warn('Failed to stream assistant transcript:', err.message)
        })
        assistantTranscriptBuffers.delete(key)
        return content
      }
      assistantTranscriptBuffers.delete(key)
      return ''
    }

    const refreshVoiceContext = async () => {
      config.voiceContextPrompt = await buildVoiceContextPrompt(config.soul, clientId)
    }

    const runMemoryFallback = async (transcript, epoch = sessionEpoch) => {
      const content = inferDirectMemoryContent(transcript)
      if (!content || epoch !== sessionEpoch || ws.readyState !== WebSocket.OPEN) return

      const readStart = Date.now()
      const items = await readMemory(clientId)
      const readResult = items.length
        ? items.map((item, index) => `[${index}] ${item.content}`).join('\n')
        : '没有找到相关记忆'
      send(ws, {
        type: 'agent_tool_call',
        toolCall: {
          name: 'memory_read',
          arguments: { query: content },
          result: readResult,
          duration_ms: Date.now() - readStart,
        },
      })

      const writeStart = Date.now()
      let writeResult = '已记住'
      if (items.some(item => item.content === content)) {
        writeResult = '已存在相同记忆，未重复写入'
      } else {
        await writeMemory(clientId, content)
      }
      send(ws, {
        type: 'agent_tool_call',
        toolCall: {
          name: 'memory_write',
          arguments: { content },
          result: writeResult,
          duration_ms: Date.now() - writeStart,
        },
      })

      await refreshVoiceContext()
      if (realtimeProvider?.ready) realtimeProvider.updateSession(config)
    }

    const scheduleMemoryFallback = (transcript) => {
      clearMemoryFallback()
      if (!inferDirectMemoryContent(transcript)) return

      const epoch = sessionEpoch
      memoryFallbackTimer = setTimeout(() => {
        memoryFallbackTimer = 0
        if (epoch !== sessionEpoch || routeFunctionPending > 0) return
        runMemoryFallback(transcript, epoch).catch(err => {
          console.warn('Voice memory fallback failed:', err.message)
        })
      }, MEMORY_FALLBACK_DELAY_MS)
    }

    const persistDirectVoiceTurn = (assistantContent) => {
      const userContent = latestUserTranscript.trim()
      if (!userContent || !assistantContent.trim()) return
      latestUserTranscript = ''
      appendToHistory(clientId, { role: 'user', content: userContent }, { role: 'assistant', content: assistantContent })
        .then(refreshVoiceContext)
        .then(() => {
          if (realtimeProvider?.ready) realtimeProvider.updateSession(config)
        })
        .catch(err => console.warn('Failed to persist direct voice turn:', err.message))
    }

    const speakProgress = (message, epoch = sessionEpoch) => {
      const text = String(message || '').trim()
      if (!text) return

      progressSpeechQueue = progressSpeechQueue
        .catch(() => {})
        .then(async () => {
          await waitForProviderIdle()
          if (epoch !== sessionEpoch || ws.readyState !== WebSocket.OPEN) return
          if (!realtimeProvider?.ready) return
          suppressedSpeechTexts.add(normalizeSpeechText(text))
          progressSpeechActive += 1
          try {
            await realtimeProvider.speakProgress(text)
          } finally {
            progressSpeechActive = Math.max(0, progressSpeechActive - 1)
            maybeSetIdle()
          }
        })
        .catch((err) => {
          console.warn('Realtime provider progress speech failed:', err.message)
        })
    }

    const handleAgentProgress = (progress, epoch = sessionEpoch) => {
      if (epoch !== sessionEpoch || ws.readyState !== WebSocket.OPEN) return
      const normalized = {
        domain: progress.domain || 'agent',
        stage: progress.stage || 'progress',
        message: progress.message || '',
        speakPolicy: progress.speakPolicy || 'silent',
      }
      progressStage = `${normalized.domain}:${normalized.stage}`
      send(ws, { type: 'agent_progress', progress: normalized })

      if (normalized.speakPolicy === 'always') {
        speakProgress(normalized.message, epoch)
      } else if (normalized.speakPolicy === 'if_slow') {
        const stageKey = progressStage
        const timer = setTimeout(() => {
          progressTimers.delete(timer)
          if (epoch === sessionEpoch && routeFunctionPending > 0 && progressStage === stageKey) {
            speakProgress(normalized.message, epoch)
          }
        }, PROGRESS_SPEECH_DELAY_MS)
        progressTimers.add(timer)
      }
    }

    const handleRouteFunctionCall = async (event) => {
      const callEpoch = sessionEpoch
      const isStaleCall = () => callEpoch !== sessionEpoch || ws.readyState !== WebSocket.OPEN
      routeFunctionPending += 1
      setState('thinking')

      if (event.name !== CAR_AGENT_TOOL_NAME) {
        try {
          realtimeProvider?.sendFunctionOutput(event.call_id, JSON.stringify({ content: `未知语音工具: ${event.name}` }))
        } finally {
          routeFunctionPending = Math.max(0, routeFunctionPending - 1)
        }
        return
      }

      let args = {}
      try {
        args = JSON.parse(event.arguments || '{}')
      } catch {
        args = {}
      }

      const utterance = args.utterance || ''
      if (!utterance.trim()) {
        try {
          realtimeProvider?.sendFunctionOutput(event.call_id, JSON.stringify({ content: '没有识别到有效语音指令。' }))
        } finally {
          routeFunctionPending = Math.max(0, routeFunctionPending - 1)
        }
        return
      }

      try {
        const vehicleState = getVehicleState?.(clientId) || {}
        const toolCalls = []
        const forwardedActions = []
        let thinking = ''
        let agentResult = null

        await chatStream(
          utterance,
          clientId,
          vehicleState,
          config.soul,
          config.routeStrategy,
          config.thinking,
          clientId,
          (agentEvent) => {
            if (isStaleCall()) return
            if (agentEvent.type === 'thinking') {
              thinking += agentEvent.content
              send(ws, { type: 'agent_thinking', content: agentEvent.content })
            } else if (agentEvent.type === 'tool_call') {
              const toolCall = {
                name: agentEvent.name,
                arguments: agentEvent.arguments,
                result: agentEvent.result,
                duration_ms: agentEvent.duration_ms,
              }
              toolCalls.push(toolCall)
              send(ws, { type: 'agent_tool_call', toolCall })
            } else if (agentEvent.type === 'progress') {
              handleAgentProgress(agentEvent, callEpoch)
            } else if (agentEvent.type === 'map_action') {
              const { type: _type, ...mapAction } = agentEvent
              send(ws, { type: 'agent_map_action', mapAction })
            } else if (agentEvent.type === 'action') {
              const action = agentEvent.action
              if (action) {
                forwardedActions.push(action)
                applyAgentActions?.(clientId, [action])
                send(ws, { type: 'agent_actions', actions: [action] })
              }
            } else if (agentEvent.type === 'done') {
              agentResult = agentEvent
            }
          },
          {
            totalTimeoutMs: VOICE_AGENT_TOTAL_TIMEOUT_MS,
            llmTimeoutMs: VOICE_AGENT_LLM_TIMEOUT_MS,
            toolTimeoutMs: VOICE_AGENT_TOOL_TIMEOUT_MS,
          },
        )

        if (isStaleCall()) return

        if (!agentResult) {
          agentResult = { content: '语音 Agent 没有返回结果', actions: [], debug: { tool_calls: toolCalls } }
        }

        const debug = {
          ...(agentResult.debug || {}),
          ...(thinking ? { thinking } : {}),
        }
        const remainingActions = (agentResult.actions || []).slice(forwardedActions.length)
        if (remainingActions.length) {
          applyAgentActions?.(clientId, remainingActions)
          send(ws, { type: 'agent_actions', actions: remainingActions })
        }
        send(ws, { type: 'agent_debug', debug })
        await progressSpeechQueue.catch(() => {})
        realtimeProvider?.sendFunctionOutput(event.call_id, JSON.stringify({
          content: agentResult.content,
          actions: agentResult.actions || [],
        }), { createResponse: false })
        if (agentResult.content) {
          streamAssistantTranscript(agentResult.content).catch(err => {
            console.warn('Failed to stream assistant transcript:', err.message)
          })
          await speakProgress(agentResult.content, callEpoch)
          await progressSpeechQueue.catch(() => {})
        }
        await refreshVoiceContext()
        if (realtimeProvider?.ready) realtimeProvider.updateSession(config)
      } catch (err) {
        if (!isStaleCall()) {
          realtimeProvider?.sendFunctionOutput(event.call_id, JSON.stringify({ content: `刚才没执行成功：${err.message}` }))
        }
      } finally {
        if (callEpoch === sessionEpoch) {
          routeFunctionPending = Math.max(0, routeFunctionPending - 1)
          if (routeFunctionPending === 0) {
            progressStage = ''
            clearProgressTimers()
            maybeSetIdle()
          }
        }
      }
    }

    const handleProviderEvent = (event) => {
      const isInterruptedResponseEvent = () => {
        const responseId = responseIdFromEvent(event)
        return Boolean(
          suppressAnonymousInterruptedResponse
          || (responseId && interruptedResponseIds.has(responseId)),
        )
      }

      if (event.type === 'input_audio_buffer.speech_started') {
        cancelActiveVoiceOutput()
        setState('listening')
      } else if (event.type === 'input_audio_buffer.speech_stopped' || event.type === 'input_audio_buffer.committed') {
        setState('thinking')
      } else if (event.type === 'response.created') {
        const responseId = event.response?.id
        activeResponseId = responseId || activeResponseId
        if (event.__voiceOrigin === 'progress' && responseId) {
          progressResponseIds.add(responseId)
        }
        providerResponseActive = true
        responseHasAudio = false
        setState('thinking')
      } else if (event.type === 'conversation.item.input_audio_transcription.completed') {
        latestUserTranscript = event.transcript || ''
        send(ws, { type: 'transcript', role: 'user', content: event.transcript || '' })
        scheduleMemoryFallback(latestUserTranscript)
      } else if (event.type === 'response.function_call_arguments.done') {
        clearMemoryFallback()
        const responseId = responseIdFromEvent(event)
        if (responseId) functionCallResponseIds.add(responseId)
        latestUserTranscript = ''
        handleRouteFunctionCall(event)
      } else if (event.type === 'response.audio.delta') {
        if (isInterruptedResponseEvent()) return
        responseHasAudio = true
        setState('speaking')
        send(ws, { type: 'audio', audio: event.delta, sampleRate: 24000 })
      } else if (event.type === 'response.audio_transcript.delta') {
        if (isInterruptedResponseEvent()) return
        setState('speaking')
        getAssistantTranscriptBuffer(responseIdFromEvent(event)).deltas += event.delta || ''
      } else if (event.type === 'response.audio_transcript.done') {
        if (isInterruptedResponseEvent()) return
        getAssistantTranscriptBuffer(responseIdFromEvent(event)).transcript = event.transcript || ''
      } else if ((event.type === 'response.done' || event.type === 'response.audio.done') && responseHasAudio) {
        send(ws, { type: 'audio_done' })
        responseHasAudio = false
        if (routeFunctionPending > 0) setState('thinking')
        if (event.type === 'response.done') {
          const responseId = responseIdFromEvent(event)
          const assistantContent = flushAssistantTranscript(responseId)
          persistDirectVoiceTurn(assistantContent)
          if (responseId) {
            progressResponseIds.delete(responseId)
            functionCallResponseIds.delete(responseId)
            interruptedResponseIds.delete(responseId)
          }
          suppressAnonymousInterruptedResponse = false
          activeResponseId = ''
          markProviderIdle()
          maybeSetIdle()
        }
      } else if (event.type === 'response.done') {
        const responseId = responseIdFromEvent(event)
        const assistantContent = flushAssistantTranscript(responseId)
        persistDirectVoiceTurn(assistantContent)
        if (responseId) {
          progressResponseIds.delete(responseId)
          functionCallResponseIds.delete(responseId)
          interruptedResponseIds.delete(responseId)
        }
        suppressAnonymousInterruptedResponse = false
        activeResponseId = ''
        markProviderIdle()
        maybeSetIdle()
      } else if (event.type === 'error') {
        markProviderIdle()
        send(ws, { type: 'error', message: event.error?.message || event.message || '语音模型错误' })
      }
    }

    const ensureRealtimeProvider = async () => {
      if (providerConnectPromise) return providerConnectPromise
      const connectEpoch = sessionEpoch
      providerConnectPromise = (async () => {
        await refreshVoiceContext()
        if (connectEpoch !== sessionEpoch) return false
        if (!realtimeProvider) {
          realtimeProvider = createRealtimeProvider(config.realtimeProviderId, {
            onEvent: handleProviderEvent,
            onClose: () => {
              setState('idle')
            },
            onError: (err) => {
              send(ws, { type: 'error', message: err.message || '语音模型连接失败' })
            },
          })
        }
        await realtimeProvider.connect(config)
        if (connectEpoch !== sessionEpoch) {
          realtimeProvider?.close()
          return false
        }
        pendingAudio.forEach(audio => realtimeProvider.appendAudio(audio))
        pendingAudio = []
        return true
      })().finally(() => {
        providerConnectPromise = null
      })
      return providerConnectPromise
    }

    send(ws, { type: 'voice_state', state: 'idle', clientId, provider: config.realtimeProviderId })

    ws.on('message', async (raw) => {
      const event = parseJson(raw)
      if (!event) {
        send(ws, { type: 'error', message: 'Invalid voice event' })
        return
      }

      if (event.type === 'mute') {
        sessionEpoch += 1
        latestUserTranscript = ''
        pendingAudio = []
        routeFunctionPending = 0
        responseHasAudio = false
        progressStage = ''
        progressSpeechQueue = Promise.resolve()
        progressSpeechActive = 0
        progressResponseIds.clear()
        functionCallResponseIds.clear()
        interruptedResponseIds.clear()
        assistantTranscriptBuffers.clear()
        suppressedSpeechTexts.clear()
        suppressAnonymousInterruptedResponse = false
        activeResponseId = ''
        markProviderIdle()
        clearProgressTimers()
        clearMemoryFallback()
        realtimeProvider?.close()
        providerConnectPromise = null
        setState('idle')
      } else if (event.type === 'config') {
        const nextRealtimeProviderId = normalizeRealtimeProviderId(event.realtimeProviderId || event.provider || config.realtimeProviderId)
        const realtimeProviderChanged = nextRealtimeProviderId !== config.realtimeProviderId
        config.soul = event.soul || config.soul
        config.routeStrategy = event.routeStrategy ?? config.routeStrategy
        config.thinking = event.thinking ?? config.thinking
        config.realtimeProviderId = nextRealtimeProviderId
        if (realtimeProviderChanged) {
          sessionEpoch += 1
          latestUserTranscript = ''
          pendingAudio = []
          routeFunctionPending = 0
          responseHasAudio = false
          progressStage = ''
          progressSpeechQueue = Promise.resolve()
          progressSpeechActive = 0
          progressResponseIds.clear()
          functionCallResponseIds.clear()
          interruptedResponseIds.clear()
          assistantTranscriptBuffers.clear()
          suppressedSpeechTexts.clear()
          suppressAnonymousInterruptedResponse = false
          activeResponseId = ''
          markProviderIdle()
          clearProgressTimers()
          clearMemoryFallback()
          realtimeProvider?.close()
          realtimeProvider = null
          providerConnectPromise = null
        }
        await refreshVoiceContext()
        if (realtimeProvider?.ready) realtimeProvider.updateSession(config)
        setState('idle')
      } else if (event.type === 'unmute') {
        try {
          await ensureRealtimeProvider()
          setState('idle')
        } catch (err) {
          send(ws, { type: 'error', message: err.message || '语音服务连接失败' })
        }
      } else if (event.type === 'audio') {
        if (realtimeProvider?.ready) {
          realtimeProvider.appendAudio(event.audio)
        } else if (event.audio) {
          pendingAudio.push(event.audio)
          if (pendingAudio.length > 30) pendingAudio.shift()
          ensureRealtimeProvider().catch(err => {
            send(ws, { type: 'error', message: err.message || '语音服务连接失败' })
          })
        }
      }
    })

    ws.on('close', () => {
      sessionEpoch += 1
      clearThinkingTimeout()
      latestUserTranscript = ''
      pendingAudio = []
      routeFunctionPending = 0
      responseHasAudio = false
      progressStage = ''
      progressSpeechQueue = Promise.resolve()
      progressSpeechActive = 0
      progressResponseIds.clear()
      functionCallResponseIds.clear()
      interruptedResponseIds.clear()
      assistantTranscriptBuffers.clear()
      suppressedSpeechTexts.clear()
      suppressAnonymousInterruptedResponse = false
      activeResponseId = ''
      markProviderIdle()
      clearProgressTimers()
      clearMemoryFallback()
      realtimeProvider?.close()
      providerConnectPromise = null
    })
  })
}
