import { emitKeypressEvents } from 'node:readline'
import { pathToFileURL } from 'node:url'
import WebSocket from 'ws'
import {
  GatewayClientEvent,
  GatewayServerEvent,
} from '../../shared/realtime-events.mjs'
import { startMacVoiceIO } from './macos-voice-io.mjs'
import { resamplePcm16 } from './pcm-audio.mjs'
import { startPortAudioVoiceIO } from './portaudio-voice-io.mjs'

const OUTPUT_SAMPLE_RATE = 24000
const AUDIO_MODES = new Set(['half', 'full'])
const ANSI = {
  bold: '\u001b[1m',
  cyan: '\u001b[36m',
  dim: '\u001b[90m',
  green: '\u001b[32m',
  red: '\u001b[31m',
  reset: '\u001b[0m',
  yellow: '\u001b[33m',
}

function style(text, color) {
  if (!process.stdout.isTTY || process.env.NO_COLOR) return text
  return `${ANSI[color]}${text}${ANSI.reset}`
}

function normalizeAudioMode(value) {
  const mode = String(value || 'half').toLowerCase()
  if (!AUDIO_MODES.has(mode)) {
    throw new Error(`不支持的音频模式：${value}（可选 half、full）`)
  }
  return mode
}

function nextArgumentValue(argv, index, option) {
  const value = argv[index + 1]
  if (!value || value.startsWith('-')) {
    throw new Error(`${option} 缺少参数`)
  }
  return value
}

function normalizeGatewayUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`无效的 Gateway URL：${value}`)
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Gateway URL 只支持 http 或 https')
  }
  return url.origin
}

export function parseArguments(argv, env = process.env) {
  const options = {
    url: env.QWEN_AUDIO_AGENT_URL || 'http://127.0.0.1:3101',
    sessionId: env.QWEN_AUDIO_AGENT_SESSION_ID || 'tui-main',
    audioMode: env.QWEN_AUDIO_AGENT_TUI_AUDIO_MODE || 'half',
    takeover: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--url') {
      options.url = nextArgumentValue(argv, index++, '--url')
    } else if (argument === '--session') {
      options.sessionId = nextArgumentValue(argv, index++, '--session')
    } else if (argv[index] === '--help' || argv[index] === '-h') {
      options.help = true
    } else if (argument === '--takeover') {
      options.takeover = true
    } else if (argument === '--audio-mode') {
      options.audioMode = nextArgumentValue(argv, index++, '--audio-mode')
    } else throw new Error(`未知参数：${argument}`)
  }
  options.url = normalizeGatewayUrl(options.url)
  options.sessionId = String(options.sessionId || '').trim()
  if (!options.sessionId) throw new Error('--session 不能为空')
  options.audioMode = normalizeAudioMode(options.audioMode)
  return options
}

export function websocketUrl(baseUrl, sessionId) {
  const url = new URL('/api/realtime', baseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('sessionId', sessionId)
  return url.toString()
}

export function connectMessage({
  voiceEnabled,
  inputEnabled,
  outputEnabled,
  takeover = false,
  workingDirectory = process.cwd(),
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
  locale = Intl.DateTimeFormat().resolvedOptions().locale,
} = {}) {
  return {
    type: GatewayClientEvent.CONNECT,
    voiceEnabled: voiceEnabled !== false,
    ...(inputEnabled === undefined
      ? {}
      : { inputEnabled: inputEnabled === true }),
    ...(outputEnabled === undefined
      ? {}
      : { outputEnabled: outputEnabled === true }),
    clientType: 'cli',
    clientLabel: 'CLI',
    takeover: takeover === true,
    workingDirectory,
    timeZone,
    locale,
  }
}

export function microphoneControlEvent(muted) {
  return muted
    ? { type: GatewayClientEvent.INPUT_MUTE }
    : { type: GatewayClientEvent.INPUT_UNMUTE, takeover: false }
}

export function permissionStatusText(task) {
  return task?.authorization?.summary || '后台正在请求执行权限'
}

function cookieFrom(response) {
  const raw = response.headers.getSetCookie?.()[0]
    || response.headers.get('set-cookie')
    || ''
  return raw.split(';', 1)[0]
}

export function assertInteractiveTerminal(stdin = process.stdin) {
  if (!stdin.isTTY) {
    throw new Error('minimal TUI 需要交互式终端，以支持按键控制')
  }
}

export async function readTuiHealth(baseUrl, {
  fetchImpl = fetch,
  timeoutMs = 5000,
} = {}) {
  let response
  try {
    response = await fetchImpl(`${baseUrl}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw new Error(`无法连接 Gateway：${error.message}`)
  }
  let health
  try {
    health = await response.json()
  } catch {
    throw new Error('Gateway 健康检查返回了无效数据')
  }
  if (!response.ok) {
    throw new Error(
      health?.backend?.error || health?.error || 'Gateway 或后台 Agent 尚未就绪',
    )
  }
  if (!health || typeof health !== 'object' || !health.backend) {
    throw new Error('Gateway 健康检查缺少后台状态')
  }
  return {
    cookie: cookieFrom(response),
    health,
  }
}

export function audioModeForPlatform(
  platform = process.platform,
  requestedMode = 'half',
) {
  if (platform === 'darwin') {
    return {
      audioBackend: 'coreaudio',
      captureDuringPlayback: true,
      fullDuplex: true,
      manualInterrupt: false,
      label: 'CoreAudio Voice Processing（全双工 AEC）',
      shortLabel: 'CoreAudio AEC',
    }
  }
  if (normalizeAudioMode(requestedMode) === 'full') {
    return {
      audioBackend: 'portaudio',
      captureDuringPlayback: true,
      fullDuplex: true,
      manualInterrupt: false,
      label: 'PortAudio（全双工，无 AEC，建议使用耳机）',
      shortLabel: 'PortAudio 全双工',
    }
  }
  return {
    audioBackend: 'portaudio',
    captureDuringPlayback: false,
    fullDuplex: false,
    manualInterrupt: true,
    label: 'PortAudio（半双工）',
    shortLabel: 'PortAudio 半双工',
  }
}

export function helpText(mode = audioModeForPlatform()) {
  const description = mode.audioBackend === 'coreaudio'
    ? '语音模式：请直接说话；使用 macOS CoreAudio 全双工回声消除，可用语音打断回复。'
    : mode.fullDuplex
      ? '语音模式：PortAudio 全双工不提供回声消除，请使用耳机；可直接说话打断回复。'
      : '语音模式：回复播放完毕后可继续说话；按 x 可手动打断播放。'
  return [
    description,
    '按键：',
    ...(mode.manualInterrupt ? ['  x  手动打断当前回复'] : []),
    '  m  静音 / 恢复麦克风',
    '  h  显示帮助',
    '  q  退出',
  ].join('\n')
}

export function fullDuplexFallbackHint(mode) {
  if (mode.audioBackend !== 'portaudio' || !mode.fullDuplex) return ''
  return 'PortAudio 全双工出现异常；请重新运行 '
    + 'qwenaudio tui --audio-mode half 使用半双工。'
}

function requestLabel(task) {
  return String(task?.objective || '正在处理用户请求')
}

function frontendLabel(holder) {
  return holder?.label || {
    desktop: '桌面端',
    cli: '终端',
    web: 'WebUI',
  }[holder?.type] || '其他前端'
}

export function canSendMicrophoneAudio({
  connected,
  muted,
  captureEnabled,
}) {
  return Boolean(connected && !muted && captureEnabled)
}

export function performManualInterrupt({
  playback,
  transcriptRenderer,
  socket,
  startMicrophone,
  print,
}) {
  playback.clear('user_interruption')
  transcriptRenderer.cancel()
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'interrupt' }))
  }
  startMicrophone()
  print(style('[已手动打断，麦克风已恢复]', 'yellow'))
}

export function completeTranscript(streamed, final) {
  const streamedText = String(streamed || '').trim()
  const finalText = String(final || '').trim()
  if (!finalText || streamedText.startsWith(finalText)) return streamedText
  return finalText
}

export function createTurnStatusDisplay({
  print,
  maxRememberedTurns = 200,
} = {}) {
  const awaitingAssistant = new Set()
  const turnOrder = []
  const pending = new Map()

  const remember = turnId => {
    const id = String(turnId || '')
    if (!id || awaitingAssistant.has(id)) return
    awaitingAssistant.add(id)
    turnOrder.push(id)
    while (turnOrder.length > maxRememberedTurns) {
      const forgotten = turnOrder.shift()
      awaitingAssistant.delete(forgotten)
      for (const line of pending.get(forgotten) || []) print(line)
      pending.delete(forgotten)
    }
  }

  const release = turnId => {
    const id = String(turnId || '')
    if (!id || !awaitingAssistant.delete(id)) return
    for (const line of pending.get(id) || []) print(line)
    pending.delete(id)
  }

  return {
    begin(turnId) {
      remember(turnId)
    },
    status(event, line) {
      const turnId = String(event?.task?.turnId || '')
      if (!turnId || !awaitingAssistant.has(turnId)) {
        print(line)
        return
      }
      const lines = pending.get(turnId) || []
      lines.push(line)
      pending.set(turnId, lines)
    },
    assistantFinished(turnId) {
      release(turnId)
    },
    reset() {
      for (const turnId of turnOrder) release(turnId)
      turnOrder.length = 0
      awaitingAssistant.clear()
    },
  }
}

export function createTranscriptDisplay({
  onUser,
  onAssistant,
  onUserDelta = () => {},
  onUserDiscard = () => {},
  onAssistantDelta = () => {},
  onReset = () => {},
}) {
  const maxRememberedTurns = 200
  const maxRememberedResponses = 200
  const userDeltas = new Map()
  const assistantDeltas = new Map()
  const completedUserTurns = new Set()
  const completedUserTurnOrder = []
  const completedAssistantResponses = new Set()
  const completedAssistantResponseOrder = []
  const pendingAssistants = new Map()
  const assistantTurns = new Map()

  const completeUserTurn = turnId => {
    if (completedUserTurns.has(turnId)) return
    completedUserTurns.add(turnId)
    completedUserTurnOrder.push(turnId)
    while (completedUserTurnOrder.length > maxRememberedTurns) {
      completedUserTurns.delete(completedUserTurnOrder.shift())
    }
  }

  const flushTurn = turnId => {
    const pending = pendingAssistants.get(turnId) || []
    pendingAssistants.delete(turnId)
    for (const item of pending) onAssistant(item.content, item.event)
    for (const [responseId, content] of assistantDeltas) {
      if (assistantTurns.get(responseId) === turnId) onAssistantDelta(content)
    }
  }

  const completeAssistantResponse = responseId => {
    if (!responseId || completedAssistantResponses.has(responseId)) return
    completedAssistantResponses.add(responseId)
    completedAssistantResponseOrder.push(responseId)
    while (completedAssistantResponseOrder.length > maxRememberedResponses) {
      completedAssistantResponses.delete(completedAssistantResponseOrder.shift())
    }
  }

  return {
    handle(event) {
      if (!event?.type?.startsWith('transcript.')) return false

      if (event.role === 'user' && event.type === 'transcript.delta') {
        const turnId = String(event.turnId || '')
        const incoming = String(event.content || '')
        const content = event.replace === true
          ? incoming
          : `${userDeltas.get(turnId) || ''}${incoming}`
        if (turnId) userDeltas.set(turnId, content)
        if (content) onUserDelta(content)
        return true
      }

      if (event.role === 'user' && event.type === 'transcript.final') {
        const turnId = String(event.turnId || '')
        const content = completeTranscript(
          userDeltas.get(turnId),
          String(event.content || '').replace(/\s+/g, ' '),
        )
        userDeltas.delete(turnId)
        if (content) onUser(content, event)
        if (turnId) {
          completeUserTurn(turnId)
          flushTurn(turnId)
        }
        return true
      }

      if (event.role === 'user' && event.type === 'transcript.discard') {
        const turnId = String(event.turnId || '')
        userDeltas.delete(turnId)
        onUserDiscard(turnId, event)
        if (turnId) {
          completeUserTurn(turnId)
          flushTurn(turnId)
        }
        return true
      }

      if (event.role !== 'assistant') return true
      const responseId = String(event.responseId || '')
      if (responseId && completedAssistantResponses.has(responseId)) return true
      if (event.type === 'transcript.delta') {
        const previous = assistantDeltas.get(responseId) || ''
        const content = previous + String(event.content || '')
        assistantDeltas.set(responseId, content)
        const turnId = String(event.turnId || '')
        if (turnId) assistantTurns.set(responseId, turnId)
        const waitsForUser = (
          event.origin === 'model'
          && turnId
          && !completedUserTurns.has(turnId)
        )
        if (!waitsForUser && content) onAssistantDelta(content)
        return true
      }
      if (event.type !== 'transcript.final') return true

      const content = completeTranscript(
        assistantDeltas.get(responseId),
        event.content,
      )
      assistantDeltas.delete(responseId)
      assistantTurns.delete(responseId)
      completeAssistantResponse(responseId)
      if (!content) return true

      const turnId = String(event.turnId || '')
      const waitsForUser = (
        event.origin === 'model'
        && turnId
        && !completedUserTurns.has(turnId)
      )
      if (!waitsForUser) {
        onAssistant(content, event)
        return true
      }
      const pending = pendingAssistants.get(turnId) || []
      pending.push({ content, event })
      pendingAssistants.set(turnId, pending)
      return true
    },
    reset() {
      userDeltas.clear()
      assistantDeltas.clear()
      completedUserTurns.clear()
      completedUserTurnOrder.length = 0
      completedAssistantResponses.clear()
      completedAssistantResponseOrder.length = 0
      pendingAssistants.clear()
      assistantTurns.clear()
      onReset()
    },
  }
}

export function createTerminalTranscriptRenderer({
  stdout = process.stdout,
} = {}) {
  let active = null
  let previewRows = 0
  const pendingLines = []
  const interactive = Boolean(stdout.isTTY)
  const stripAnsi = text => String(text || '').replace(/\u001b\[[0-9;]*m/g, '')
  const characterWidth = character => {
    const codePoint = character.codePointAt(0) || 0
    if (
      codePoint === 0
      || codePoint < 32
      || (codePoint >= 0x7f && codePoint < 0xa0)
      || (codePoint >= 0x300 && codePoint <= 0x36f)
      || (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
      || codePoint === 0x200d
    ) return 0
    return codePoint <= 0x7e ? 1 : 2
  }
  const displayWidth = text => Array.from(stripAnsi(text))
    .reduce((width, character) => width + characterWidth(character), 0)
  const previewLines = (prefix, content) => {
    const columns = Math.max(8, Number(stdout.columns) || 80)
    // Leave one terminal column unused to avoid exact-width auto-wrap, whose
    // cursor behavior differs between terminals.
    const maxWidth = Math.max(7, columns - 1)
    const firstPrefix = `${prefix} `
    const prefixWidth = displayWidth(firstPrefix)
    const continuation = ' '.repeat(Math.min(prefixWidth, maxWidth - 2))
    const continuationWidth = displayWidth(continuation)
    const points = Array.from(String(content || '').replace(/\s+/g, ' '))
    const lines = []
    let line = firstPrefix
    let width = prefixWidth
    for (const point of points) {
      const pointWidth = characterWidth(point)
      const minimumWidth = lines.length === 0 ? prefixWidth : continuationWidth
      if (width > minimumWidth && width + pointWidth > maxWidth) {
        lines.push(line)
        line = continuation
        width = continuationWidth
      }
      line += point
      width += pointWidth
    }
    lines.push(line)
    return lines
  }
  const clearPreview = () => {
    if (!interactive || previewRows === 0) return
    stdout.write('\r\u001b[2K')
    for (let row = 1; row < previewRows; row += 1) {
      stdout.write('\u001b[1A\r\u001b[2K')
    }
    previewRows = 0
  }
  const redrawPreview = () => {
    if (!interactive || active?.kind !== 'preview') return
    clearPreview()
    const lines = previewLines(active.prefix, active.content)
    stdout.write(lines.join('\n'))
    previewRows = lines.length
  }
  const flushPending = () => {
    while (pendingLines.length) stdout.write(`${pendingLines.shift()}\n`)
  }
  const closeActiveStream = () => {
    if (active?.kind !== 'stream') return
    stdout.write('\n')
    active = null
    flushPending()
  }
  return {
    update(prefix, content) {
      // A provisional user ASR snapshot can arrive while the assistant is
      // still speaking (for example from residual playback). Do not let that
      // ephemeral preview split the assistant's cumulative transcript into
      // two terminal lines. A real interruption clears playback first, and a
      // final user transcript will still close the stream in finish().
      if (active?.kind === 'stream') return
      active = {
        kind: 'preview',
        prefix: String(prefix || ''),
        content: String(content || ''),
      }
      redrawPreview()
    },
    stream(prefix, content) {
      const nextPrefix = String(prefix || '')
      const nextContent = String(content || '')
      if (active?.kind === 'preview') clearPreview()
      if (active?.kind !== 'stream' || active.prefix !== nextPrefix) {
        if (active?.kind === 'stream') closeActiveStream()
        stdout.write(`${nextPrefix} ${nextContent}`)
      } else if (nextContent.startsWith(active.content)) {
        stdout.write(nextContent.slice(active.content.length))
      } else if (!active.content.startsWith(nextContent)) {
        stdout.write(`\n${nextPrefix} ${nextContent}`)
      }
      active = { kind: 'stream', prefix: nextPrefix, content: nextContent }
    },
    finish(prefix, content) {
      const nextPrefix = String(prefix || '')
      const nextContent = String(content || '')
      if (active?.kind === 'preview') {
        clearPreview()
        stdout.write(`${nextPrefix} ${nextContent}\n`)
      } else if (active?.kind === 'stream' && active.prefix === nextPrefix) {
        const complete = completeTranscript(active.content, nextContent)
        if (complete.startsWith(active.content)) {
          stdout.write(`${complete.slice(active.content.length)}\n`)
        } else if (active.content.startsWith(complete)) {
          stdout.write('\n')
        } else {
          stdout.write(`\n${nextPrefix} ${complete}\n`)
        }
      } else {
        if (active?.kind === 'stream') stdout.write('\n')
        stdout.write(`${nextPrefix} ${nextContent}\n`)
      }
      active = null
      flushPending()
    },
    print(line) {
      if (active?.kind === 'stream') {
        pendingLines.push(String(line))
        return
      }
      if (active?.kind === 'preview') clearPreview()
      stdout.write(`${line}\n`)
      redrawPreview()
    },
    discardPreview() {
      if (active?.kind !== 'preview') return
      clearPreview()
      active = null
      flushPending()
    },
    cancel() {
      if (active?.kind === 'preview') clearPreview()
      else if (active?.kind === 'stream') stdout.write('\n')
      active = null
      flushPending()
    },
  }
}

export function createPlayback({
  audioSink,
  onError,
  onStarted,
  onEnded,
  onCancelled,
  onIdle,
}) {
  const activeResponses = new Set()
  const startedResponses = new Set()
  const finishingResponses = new Set()
  const cancelledResponses = new Set()
  const cancelledResponseOrder = []
  const rememberCancelled = responseId => {
    if (!responseId || cancelledResponses.has(responseId)) return
    cancelledResponses.add(responseId)
    cancelledResponseOrder.push(responseId)
    while (cancelledResponseOrder.length > 200) {
      cancelledResponses.delete(cancelledResponseOrder.shift())
    }
  }
  const stop = (reason = '') => {
    for (const responseId of activeResponses) {
      rememberCancelled(responseId)
      onCancelled?.(responseId, reason)
    }
    activeResponses.clear()
    startedResponses.clear()
    finishingResponses.clear()
    audioSink.clear()
  }
  return {
    write(base64, rate = OUTPUT_SAMPLE_RATE, responseId = '') {
      if (responseId && cancelledResponses.has(responseId)) return false
      let buffer = Buffer.from(base64, 'base64')
      if (!buffer.length) return true
      try {
        buffer = resamplePcm16(buffer, rate, OUTPUT_SAMPLE_RATE)
      } catch (error) {
        onError?.(error.message)
        if (responseId) {
          rememberCancelled(responseId)
          onCancelled?.(responseId)
        }
        return false
      }
      if (!audioSink.write(buffer, OUTPUT_SAMPLE_RATE, responseId)) {
        onError?.('音频设备未接受播放数据')
        if (responseId) {
          rememberCancelled(responseId)
          onCancelled?.(responseId)
        }
        return false
      }
      if (responseId) activeResponses.add(responseId)
      return true
    },
    done(responseId = '') {
      if (
        !responseId
        || cancelledResponses.has(responseId)
        || !activeResponses.has(responseId)
        || finishingResponses.has(responseId)
      ) return
      if (audioSink.done?.(responseId)) {
        finishingResponses.add(responseId)
      } else {
        onError?.('音频设备未接受播放完成标记')
        rememberCancelled(responseId)
        activeResponses.delete(responseId)
        startedResponses.delete(responseId)
        finishingResponses.delete(responseId)
        onCancelled?.(responseId)
        if (activeResponses.size === 0) onIdle?.()
      }
    },
    started(responseId = '') {
      if (
        !responseId
        || cancelledResponses.has(responseId)
        || !activeResponses.has(responseId)
        || startedResponses.has(responseId)
      ) return
      startedResponses.add(responseId)
      onStarted?.(responseId)
    },
    ended(responseId = '') {
      if (
        !responseId
        || cancelledResponses.has(responseId)
        || !activeResponses.delete(responseId)
      ) return
      startedResponses.delete(responseId)
      finishingResponses.delete(responseId)
      onEnded?.(responseId)
      if (activeResponses.size === 0) onIdle?.()
    },
    clear: stop,
    close: stop,
  }
}

export async function runTui(options = parseArguments(process.argv.slice(2))) {
  const audioMode = audioModeForPlatform(process.platform, options.audioMode)
  if (options.help) {
    process.stdout.write(
      'qwen-audio-agent Voice TUI\n\n'
      + '用法：qwenaudio tui [--url URL] [--session ID] '
      + '[--audio-mode half|full] [--takeover]\n\n'
      + `${helpText(audioMode)}\n`,
    )
    return
  }

  assertInteractiveTerminal()
  const { cookie, health } = await readTuiHealth(options.url)

  let headers = cookie ? { Cookie: cookie } : {}
  let inputSampleRate = health.realtimeInputSampleRate || 16000
  let muted = false
  let closed = false
  let socket = null
  let reconnectTimer = null
  let reconnectDelay = 500
  let connectedOnce = false
  let frontendReady = false
  let ownsVoice = false
  let everOwnedVoice = false
  let captureEnabled = false
  let captureStateSent = false
  let audioBridge = null
  let playback = null
  let keypressHandler = null
  const pendingPermissionTasks = new Set()
  let close = () => {}
  let resolveClosed
  const closedPromise = new Promise(resolvePromise => {
    resolveClosed = resolvePromise
  })

  const transcriptRenderer = createTerminalTranscriptRenderer()
  const print = text => transcriptRenderer.print(text)
  const userPrefix = style('你 >', 'cyan')
  const assistantPrefix = style('qwen-audio >', 'bold')
  const turnStatusDisplay = createTurnStatusDisplay({ print })
  const transcriptDisplay = createTranscriptDisplay({
    onUserDelta: content => transcriptRenderer.update(userPrefix, content),
    onUser: (content, event) => {
      transcriptRenderer.finish(userPrefix, content)
      turnStatusDisplay.begin(event?.turnId)
    },
    onUserDiscard: (_turnId, event) => {
      transcriptRenderer.discardPreview()
      if (
        event?.reason === 'turn_invalid'
        && pendingPermissionTasks.size > 0
      ) {
        print(style('[没有听清授权回答，请再说一次]', 'yellow'))
      }
    },
    onAssistantDelta: content => transcriptRenderer.stream(assistantPrefix, content),
    onAssistant: (content, event) => {
      transcriptRenderer.finish(assistantPrefix, content)
      turnStatusDisplay.assistantFinished(event?.turnId)
    },
    onReset: () => {
      transcriptRenderer.cancel()
      turnStatusDisplay.reset()
    },
  })
  const handleSigint = () => close()
  const handleSigterm = () => close()
  const cleanup = () => {
    if (closed) return
    closed = true
    clearTimeout(reconnectTimer)
    playback?.close()
    audioBridge?.close()
    if (keypressHandler) process.stdin.off('keypress', keypressHandler)
    process.off('SIGINT', handleSigint)
    process.off('SIGTERM', handleSigterm)
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false)
      } catch {
        // The terminal may already have closed while the audio helper exited.
      }
    }
    process.stdin.pause()
    resolveClosed()
  }
  close = () => {
    cleanup()
    if (socket?.readyState < WebSocket.CLOSING) socket.close()
  }
  const sendMicrophoneAudio = chunk => {
    if (canSendMicrophoneAudio({
      connected: socket?.readyState === WebSocket.OPEN,
      muted,
      captureEnabled,
    })) {
      socket.send(JSON.stringify({
        type: 'audio.append',
        audio: chunk.toString('base64'),
      }))
    }
  }

  const startVoiceIO = audioMode.audioBackend === 'coreaudio'
    ? startMacVoiceIO
    : startPortAudioVoiceIO

  const fallbackHint = fullDuplexFallbackHint(audioMode)
  let fallbackHintPrinted = false
  const printFallbackHint = () => {
    if (!fallbackHint || fallbackHintPrinted) return
    fallbackHintPrinted = true
    print(style(`[建议] ${fallbackHint}`, 'yellow'))
  }
  const reportAudioError = message => {
    print(`${style('[音频]', 'red')} ${message}`)
    printFallbackHint()
  }

  let bridgeExited = false
  try {
    audioBridge = await startVoiceIO({
      captureSampleRate: inputSampleRate,
      duplexMode: audioMode.fullDuplex ? 'full' : 'half',
      onAudio: sendMicrophoneAudio,
      onPlaybackStarted: responseId => playback?.started(responseId),
      onPlaybackEnded: responseId => playback?.ended(responseId),
      onError: reportAudioError,
      onExit: ({ code, signal }) => {
        bridgeExited = true
        if (!closed) {
          print(style(
            `[音频设备已停止：${code ?? signal ?? 'unknown'}]`,
            'red',
          ))
          printFallbackHint()
          close()
        }
      },
    })
  } catch (error) {
    if (!fallbackHint) throw error
    throw new Error(`${error.message}\n建议：${fallbackHint}`, { cause: error })
  }
  if (closed) {
    audioBridge.close()
    return
  }
  const setCaptureEnabled = enabled => {
    const next = Boolean(enabled)
    if (captureStateSent && captureEnabled === next) return false
    captureEnabled = next
    captureStateSent = true
    audioBridge.setCaptureEnabled(next)
    return true
  }
  setCaptureEnabled(false)

  playback = createPlayback({
    audioSink: audioBridge,
    onError: message => print(`${style('[播放错误]', 'red')} ${message}`),
    onStarted: responseId => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: GatewayClientEvent.PLAYBACK_STARTED,
          responseId,
        }))
      }
    },
    onEnded: responseId => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: GatewayClientEvent.PLAYBACK_ENDED,
          responseId,
        }))
      }
    },
    onCancelled: (responseId, reason = '') => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: GatewayClientEvent.PLAYBACK_CANCELLED,
          responseId,
          ...(reason ? { reason } : {}),
        }))
      }
    },
    onIdle: () => {
      if (!audioMode.captureDuringPlayback) startMicrophone()
    },
  })

  const startMicrophone = () => {
    if (
      muted
      || !frontendReady
      || !ownsVoice
      || closed
      || bridgeExited
      || socket?.readyState !== WebSocket.OPEN
    ) return
    if (setCaptureEnabled(true)) {
      print(`[麦克风已开启 · ${inputSampleRate} Hz · ${audioMode.shortLabel}]`)
    }
  }

  const setMuted = value => {
    muted = value
    if (muted) {
      setCaptureEnabled(false)
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(microphoneControlEvent(true)))
      }
      print(style(
        '[麦克风已静音，语音输入不会被识别；按 m 恢复]',
        'yellow',
      ))
      if (pendingPermissionTasks.size > 0) {
        print(style('[正在等待授权，恢复麦克风后再回答]', 'yellow'))
      }
    } else {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(microphoneControlEvent(false)))
      }
      print(style('[麦克风已恢复]', 'green'))
      startMicrophone()
    }
  }

  const handleGatewayMessage = raw => {
    let event
    try {
      event = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (event.type === GatewayServerEvent.VOICE_READY) {
      frontendReady = true
      const nextRate = Number(event.inputSampleRate) || inputSampleRate
      if (nextRate !== inputSampleRate) {
        print(`${style('[音频配置错误]', 'red')} Gateway 要求 ${nextRate} Hz，`
          + `但音频设备已按 ${inputSampleRate} Hz 启动`)
        close()
        return
      }
      if (ownsVoice) startMicrophone()
    }
    if (event.type === GatewayServerEvent.VOICE_OWNERSHIP) {
      if (event.state === 'active') {
        ownsVoice = true
        everOwnedVoice = true
        startMicrophone()
      } else if (event.state === 'busy') {
        ownsVoice = false
        setCaptureEnabled(false)
        playback.clear()
        const holder = frontendLabel(event.holder)
        if (!everOwnedVoice) {
          print(style(
            `[语音正由${holder}使用；如需接管，请运行 qwenaudio tui --takeover]`,
            'yellow',
          ))
          close()
        } else {
          muted = true
          print(style(`[语音正由${holder}使用]`, 'yellow'))
        }
      }
    }
    if (event.type === GatewayServerEvent.VOICE_DEACTIVATED) {
      ownsVoice = false
      muted = true
      setCaptureEnabled(false)
      playback.clear()
      transcriptRenderer.cancel()
      print(style('[语音已切换到另一窗口]', 'yellow'))
    }
    if (event.type === GatewayServerEvent.PLAYBACK_CLEAR) {
      playback.clear(event.reason || '')
      transcriptRenderer.cancel()
      if (!audioMode.captureDuringPlayback) startMicrophone()
    }
    if (event.type === GatewayServerEvent.AUDIO_DELTA) {
      if (!audioMode.captureDuringPlayback) setCaptureEnabled(false)
      const accepted = playback.write(
        event.audio,
        Number(event.sampleRate) || OUTPUT_SAMPLE_RATE,
        event.responseId,
      )
      if (!audioMode.captureDuringPlayback && !accepted) startMicrophone()
    }
    if (event.type === GatewayServerEvent.AUDIO_DONE) {
      playback.done(event.responseId)
    }
    transcriptDisplay.handle(event)
    if (event.type === 'timeline.inline') {
      const content = event.item?.content || event.item?.markdown || ''
      if (content) print(`${style('── 执行结果 ──', 'cyan')}\n${content}`)
    }
    if (event.type === 'task.running') {
      turnStatusDisplay.status(
        event,
        `${style('[正在处理]', 'yellow')} ${requestLabel(event.task)}`,
      )
    }
    if (event.type === 'task.delegated') {
      // A pending permission is the actionable state. Do not immediately
      // obscure it with the broader delegated state for the same task.
      if (event.task.authorization?.status !== 'pending') {
        turnStatusDisplay.status(
          event,
          `${style('[项目执行中]', 'yellow')} ${requestLabel(event.task)}`,
        )
      }
    }
    if (event.type === 'task.finalizing') {
      turnStatusDisplay.status(
        event,
        `${style('[正在整理结果]', 'yellow')} ${requestLabel(event.task)}`,
      )
    }
    if (event.type === 'task.cancelling') {
      turnStatusDisplay.status(
        event,
        `${style('[正在取消]', 'yellow')} ${requestLabel(event.task)}`,
      )
    }
    if (event.type === 'task.permission.requested') {
      if (event.task?.id) pendingPermissionTasks.add(event.task.id)
      turnStatusDisplay.status(
        event,
        `${style('[需要确认]', 'yellow')} ${permissionStatusText(event.task)}`,
      )
      if (muted) {
        print(style(
          '[正在等待授权，但麦克风已静音；按 m 恢复后再回答]',
          'yellow',
        ))
      }
    }
    if (
      event.type === 'task.permission.resolved'
      || event.type === 'task.completed'
      || event.type === 'task.failed'
      || event.type === 'task.cancelled'
    ) {
      if (event.task?.id) pendingPermissionTasks.delete(event.task.id)
    }
    if (event.type === 'task.failed') {
      turnStatusDisplay.status(
        event,
        `${style('[处理失败]', 'red')} ${
          event.task.error || requestLabel(event.task)
        }`,
      )
    }
    if (event.type === 'error') {
      transcriptRenderer.cancel()
      print(`${style('[错误]', 'red')} ${event.message}`)
    }
  }

  const syncActiveTasks = async () => {
    const url = new URL('/api/tasks', options.url)
    url.searchParams.set('sessionId', options.sessionId)
    url.searchParams.set('active', 'true')
    const response = await fetch(url, { headers })
    if (!response.ok) {
      throw new Error(`任务状态恢复失败（${response.status}）`)
    }
    const payload = await response.json()
    for (const task of payload.tasks || []) {
      const type = task.authorization?.status === 'pending'
        ? 'task.permission.requested'
        : `task.${task.status}`
      handleGatewayMessage(JSON.stringify({ type, task }))
    }
  }

  const connectGateway = () => {
    if (closed || bridgeExited) return
    const nextSocket = new WebSocket(
      websocketUrl(options.url, options.sessionId),
      { headers },
    )
    socket = nextSocket
    nextSocket.on('open', () => {
      if (socket !== nextSocket || closed) return
      reconnectDelay = 500
      nextSocket.send(JSON.stringify(connectMessage({
        voiceEnabled: true,
        inputEnabled: !muted,
        outputEnabled: true,
        takeover: options.takeover === true,
      })))
      syncActiveTasks().catch(error => {
        print(style(`[任务状态] ${error.message}`, 'yellow'))
      })
      if (connectedOnce) {
        print(style('[qwen-audio-agent 已重新连接]', 'green'))
      } else {
        connectedOnce = true
        print(
          `${style('qwen-audio-agent Voice TUI', 'bold')} · ${health.realtimeLabel} → ${health.backend.label}\n`
          + `会话：${options.sessionId}\n`
          + `音频：${audioMode.label}\n`
          + `${helpText(audioMode)}\n`,
        )
      }
    })
    nextSocket.on('message', handleGatewayMessage)
    nextSocket.on('error', error => {
      if (!closed) print(`${style('[连接错误]', 'red')} ${error.message}`)
    })
    nextSocket.on('close', () => {
      if (socket !== nextSocket) return
      socket = null
      frontendReady = false
      ownsVoice = false
      setCaptureEnabled(false)
      playback.clear()
      transcriptDisplay.reset()
      if (closed) {
        print('qwen-audio-agent 连接已关闭。')
        return
      }
      if (bridgeExited) {
        cleanup()
        return
      }
      print(style('[qwen-audio-agent 连接中断，正在重连]', 'yellow'))
      scheduleReconnect()
    })
  }

  const scheduleReconnect = () => {
    if (closed || bridgeExited) return
    const delay = reconnectDelay
    reconnectDelay = Math.min(5000, reconnectDelay * 2)
    clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(async () => {
      if (closed || bridgeExited) return
      try {
        const refreshed = await readTuiHealth(options.url)
        const nextRate = Number(
          refreshed.health.realtimeInputSampleRate,
        ) || inputSampleRate
        if (nextRate !== inputSampleRate) {
          print(
            `${style('[音频配置已变化]', 'red')} Gateway 现在要求 `
            + `${nextRate} Hz，请重新启动 TUI`,
          )
          close()
          return
        }
        headers = refreshed.cookie ? { Cookie: refreshed.cookie } : {}
        connectGateway()
      } catch (error) {
        print(style(`[等待 Gateway] ${error.message}`, 'yellow'))
        scheduleReconnect()
      }
    }, delay)
  }

  connectGateway()

  emitKeypressEvents(process.stdin)
  process.stdin.setRawMode(true)
  process.stdin.resume()
  keypressHandler = async (value, key = {}) => {
    try {
      if ((key.ctrl && key.name === 'c') || value === 'q') {
        close()
      } else if (value === 'm') {
        setMuted(!muted)
      } else if (value === 'x' && audioMode.manualInterrupt) {
        performManualInterrupt({
          playback,
          transcriptRenderer,
          socket,
          startMicrophone,
          print,
        })
      } else if (value === 'h') {
        print(helpText(audioMode))
      }
    } catch (error) {
      print(`[错误] ${error.message}`)
    }
  }
  process.stdin.on('keypress', keypressHandler)

  process.once('SIGINT', handleSigint)
  process.once('SIGTERM', handleSigterm)
  await closedPromise
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  runTui().catch(error => {
    process.stderr.write(`qwen-audio-agent TUI 启动失败：${error.message}\n`)
    process.exitCode = 1
  })
}
