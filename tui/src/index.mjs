import { emitKeypressEvents } from 'node:readline'
import { pathToFileURL } from 'node:url'
import WebSocket from 'ws'
import {
  GatewayClientEvent,
  GatewayServerEvent,
} from '../../shared/realtime-events.mjs'
import {
  createGatewayClientState,
  reduceGatewayClientState,
} from '../../shared/gateway-client-state.mjs'
import {
  displayInputText,
  inputFileParts,
  inputText,
} from '../../shared/input-parts.mjs'
import { createLogger } from '../../shared/logger.mjs'
import { clientInputCapabilities } from '../../shared/client-input-capabilities.mjs'
import { GatewayClient } from '../../shared/gateway-client-sdk.mjs'
import { gatewayReferenceClientCapabilities } from '../../shared/gateway-client-profiles.mjs'
import { formatCitationLines } from '../../shared/citation-display.mjs'
import { startMacVoiceIO } from './macos-voice-io.mjs'
import { resamplePcm16 } from './pcm-audio.mjs'
import { startPortAudioVoiceIO } from './portaudio-voice-io.mjs'
import {
  inputPartsFromText,
} from './input-parts.mjs'
import { isExitCommand } from './terminal-commands.mjs'

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
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--url') {
      options.url = nextArgumentValue(argv, index++, '--url')
    } else if (argument === '--session') {
      options.sessionId = nextArgumentValue(argv, index++, '--session')
    } else if (argv[index] === '--help' || argv[index] === '-h') {
      options.help = true
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
    inputCapabilities: clientInputCapabilities('cli'),
    workingDirectory,
    timeZone,
    locale,
  }
}

export function microphoneControlEvent(muted) {
  return muted
    ? { type: GatewayClientEvent.INPUT_MUTE }
    : { type: GatewayClientEvent.INPUT_UNMUTE }
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

export function realtimeModelStatusText(health = {}) {
  const profile = health.realtimeModelProfile
  const label = profile?.label || health.realtimeLabel || health.realtimeModel || 'Legacy Realtime'
  const visual = profile?.transportCapabilities?.imageInput === true
    ? '已支持图片输入'
    : '视觉输入：未支持'
  return `Realtime：${label} · ${visual}`
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
      : '语音模式：回复播放完毕后可继续说话；使用 /interrupt 可手动打断播放。'
  return [
    description,
    '输入区常驻：直接输入文字并回车；粘贴文件路径会自动作为附件。',
    '文字中使用 @文件路径，可同时提交指令和附件。',
    '命令：',
    ...(mode.manualInterrupt ? ['  /interrupt       手动打断当前回复'] : []),
    '  /mute           静音 / 恢复麦克风',
    '  /help           显示帮助',
    '  /exit           退出（/quit、/q 同义）',
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

export function canStartTuiCapture({
  clientState,
  muted,
  closed,
  bridgeExited,
  socketOpen,
}) {
  return Boolean(
    !muted
    && clientState?.voiceReady
    && clientState?.ownership?.state === 'active'
    && !closed
    && !bridgeExited
    && socketOpen,
  )
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
    socket.send({ type: 'interrupt' })
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

export function createPersistentTerminalRenderer({
  stdin = process.stdin,
  stdout = process.stdout,
  prompt = '你 > ',
  onLine = async () => {},
  onPaste = async value => value,
  onChange = () => {},
  onClose = () => {},
} = {}) {
  const entries = []
  let activePreview = ''
  let draft = []
  let cursor = 0
  let scrollOffset = 0
  let pasteBuffer = null
  let pasteQueue = Promise.resolve()
  const pendingPastes = []
  let status = 'Gateway 连接中 · 麦克风准备中'
  let closed = false
  let closeRequested = false
  let lineQueue = Promise.resolve()
  const maxHistoryEntries = 2000
  const stripAnsi = text => String(text || '').replace(/\u001b\[[0-9;]*m/g, '')
  const characterWidth = character => {
    const point = character.codePointAt(0) || 0
    if (
      point === 0
      || point < 32
      || (point >= 0x7f && point < 0xa0)
      || (point >= 0x300 && point <= 0x36f)
      || (point >= 0xfe00 && point <= 0xfe0f)
      || point === 0x200d
    ) return 0
    return point <= 0x7e ? 1 : 2
  }
  const displayWidth = text => Array.from(stripAnsi(text))
    .reduce((width, character) => width + characterWidth(character), 0)
  const truncate = (text, maxWidth) => {
    let result = ''
    let width = 0
    for (const character of Array.from(stripAnsi(text))) {
      const next = characterWidth(character)
      if (width + next > maxWidth) break
      result += character
      width += next
    }
    return result
  }
  const wrap = (text, maxWidth) => {
    const lines = []
    for (const sourceLine of stripAnsi(text).split('\n')) {
      let line = ''
      let width = 0
      for (const character of Array.from(sourceLine)) {
        const next = characterWidth(character)
        if (line && width + next > maxWidth) {
          lines.push(line)
          line = ''
          width = 0
        }
        line += character
        width += next
      }
      lines.push(line)
    }
    return lines
  }
  const inputViewport = maxWidth => {
    let start = cursor
    let width = 0
    while (start > 0) {
      const next = characterWidth(draft[start - 1])
      if (width + next > maxWidth) break
      start -= 1
      width += next
    }
    let end = cursor
    let afterWidth = width
    while (end < draft.length) {
      const next = characterWidth(draft[end])
      if (afterWidth + next > maxWidth) break
      afterWidth += next
      end += 1
    }
    return {
      content: draft.slice(start, end).join(''),
      cursorColumn: draft.slice(start, cursor)
        .reduce((sum, character) => sum + characterWidth(character), 0),
    }
  }
  const redraw = () => {
    if (closed) return
    const columns = Math.max(20, Number(stdout.columns) || 80)
    // Avoid writing into the last terminal column. Some terminals immediately
    // auto-wrap an exact-width line and would shift the fixed composer down.
    const contentWidth = columns - 1
    const rows = Math.max(8, Number(stdout.rows) || 24)
    const conversationRows = rows - 4
    const source = activePreview
      ? [...entries, activePreview]
      : entries
    const allLines = source.flatMap(entry => wrap(entry, contentWidth))
    const maxOffset = Math.max(0, allLines.length - conversationRows)
    scrollOffset = Math.min(scrollOffset, maxOffset)
    const end = Math.max(0, allLines.length - scrollOffset)
    const start = Math.max(0, end - conversationRows)
    const visible = allLines.slice(start, end)
    while (visible.length < conversationRows) visible.unshift('')
    const separator = '─'.repeat(contentWidth)
    const input = inputViewport(Math.max(
      1,
      contentWidth - displayWidth(prompt),
    ))
    const visibleStatus = scrollOffset > 0
      ? `${status} · 已上翻 ${scrollOffset} 行`
      : status
    const footer = [
      separator,
      truncate(visibleStatus, contentWidth),
      `${prompt}${input.content}`,
      truncate(
        'Enter 发送 · /help 命令 · PgUp/PgDn 滚动 · Ctrl-C 退出',
        contentWidth,
      ),
    ]
    const screen = [...visible, ...footer]
      .map(value => `\u001b[2K${value}`)
      .join('\n')
    const inputRow = conversationRows + 3
    const inputColumn = Math.min(
      contentWidth,
      displayWidth(prompt) + input.cursorColumn + 1,
    )
    stdout.write(
      `\u001b[?25l\u001b[H${screen}`
      + `\u001b[${inputRow};${inputColumn}H\u001b[?25h`,
    )
  }
  const append = value => {
    const content = String(value || '').replace(/\n+$/, '')
    if (content) entries.push(content)
    if (entries.length > maxHistoryEntries) {
      entries.splice(0, entries.length - maxHistoryEntries)
    }
    scrollOffset = 0
    redraw()
  }
  const renderer = {
    update(prefix, content) {
      activePreview = `${prefix} ${content}`
      scrollOffset = 0
      redraw()
    },
    stream(prefix, content) {
      activePreview = `${prefix} ${content}`
      scrollOffset = 0
      redraw()
    },
    finish(prefix, content) {
      activePreview = ''
      append(`${prefix} ${content}`)
    },
    print(value) {
      append(value)
    },
    setStatus(value) {
      status = String(value || '')
      redraw()
    },
    discardPreview() {
      if (!activePreview) return
      activePreview = ''
      redraw()
    },
    cancel() {
      if (!activePreview) return
      activePreview = ''
      redraw()
    },
    close() {
      if (closed) return
      closed = true
      stdin.off('keypress', handleKeypress)
      stdout.off?.('resize', redraw)
      if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
        stdin.setRawMode(false)
      }
      stdout.write('\u001b[?2004l\u001b[?25h\u001b[?1049l')
    },
  }
  const submit = value => {
    lineQueue = lineQueue
      .then(() => onLine(value))
      .catch(error => renderer.print(`[错误] ${error.message}`))
      .finally(redraw)
  }
  const requestClose = () => {
    if (closed || closeRequested) return
    closeRequested = true
    onClose()
  }
  const insert = value => {
    const inserted = Array.from(value)
    const start = cursor
    draft.splice(cursor, 0, ...inserted)
    cursor += inserted.length
    return { start, length: inserted.length }
  }
  const resolvePaste = (value, insertion) => {
    pendingPastes.push(insertion)
    pasteQueue = pasteQueue
      .then(() => onPaste(value))
      .then(result => {
        if (closed) return
        const replacement = typeof result === 'string'
          ? result
          : String(result?.text ?? value)
        const original = draft
          .slice(insertion.start, insertion.start + insertion.length)
          .join('')
        if (original !== value) return
        const characters = Array.from(replacement)
        draft.splice(insertion.start, insertion.length, ...characters)
        const delta = characters.length - insertion.length
        for (const pending of pendingPastes) {
          if (pending !== insertion && pending.start > insertion.start) {
            pending.start += delta
          }
        }
        if (cursor >= insertion.start + insertion.length) cursor += delta
        else if (cursor > insertion.start) cursor = insertion.start + characters.length
        result?.apply?.()
        onChange(draft.join(''))
        redraw()
      })
      .catch(error => renderer.print(`[附件错误] ${error.message}`))
      .finally(() => {
        const index = pendingPastes.indexOf(insertion)
        if (index >= 0) pendingPastes.splice(index, 1)
      })
  }
  const handleKeypress = (value, key = {}) => {
    if (closed) return
    if (key.name === 'paste-start') {
      pasteBuffer = ''
      return
    }
    if (key.name === 'paste-end') {
      const pasted = String(pasteBuffer || '').replace(/[\r\n]+/g, ' ')
      pasteBuffer = null
      if (!pasted) return
      const insertion = insert(pasted)
      redraw()
      resolvePaste(pasted, insertion)
      return
    }
    if (pasteBuffer !== null) {
      pasteBuffer += value || ''
      return
    }
    if (key.ctrl && key.name === 'c') {
      requestClose()
      return
    }
    if (key.name === 'return' || key.name === 'enter') {
      const submitted = draft.join('')
      draft = []
      cursor = 0
      scrollOffset = 0
      redraw()
      submit(submitted)
      return
    }
    let changed = false
    if (key.name === 'backspace') {
      if (cursor > 0) {
        draft.splice(--cursor, 1)
        changed = true
      }
    } else if (key.name === 'delete') {
      if (cursor < draft.length) {
        draft.splice(cursor, 1)
        changed = true
      }
    } else if (key.name === 'left') {
      cursor = Math.max(0, cursor - 1)
    } else if (key.name === 'right') {
      cursor = Math.min(draft.length, cursor + 1)
    } else if (key.name === 'home') {
      cursor = 0
    } else if (key.name === 'end') {
      cursor = draft.length
    } else if (key.name === 'pageup') {
      scrollOffset += Math.max(1, (Number(stdout.rows) || 24) - 5)
    } else if (key.name === 'pagedown') {
      scrollOffset = Math.max(0, scrollOffset - Math.max(
        1,
        (Number(stdout.rows) || 24) - 5,
      ))
    } else if (key.ctrl || key.meta || key.name === 'escape') {
      return
    } else if (value && !/^[\u0000-\u001f\u007f]$/.test(value)) {
      insert(value)
      changed = true
    } else return
    if (changed) onChange(draft.join(''))
    redraw()
  }
  emitKeypressEvents(stdin)
  if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
    stdin.setRawMode(true)
  }
  stdin.on('keypress', handleKeypress)
  stdout.on?.('resize', redraw)
  stdout.write('\u001b[?1049h\u001b[?2004h')
  redraw()
  return renderer
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
      + '[--audio-mode half|full]\n\n'
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
  let gatewayClientState = createGatewayClientState()
  let everOwnedVoice = false
  let captureEnabled = false
  let captureStateSent = false
  let audioBridge = null
  let playback = null
  let handleTerminalLine = async () => {}
  let stagedInputParts = []
  let reconcileStagedInputParts = () => {}
  const typedTranscripts = []
  const pendingPermissionTasks = new Set()
  let close = () => {}
  let resolveClosed
  const closedPromise = new Promise(resolvePromise => {
    resolveClosed = resolvePromise
  })

  const transcriptRenderer = createPersistentTerminalRenderer({
    onLine: value => handleTerminalLine(value),
    onPaste: async value => {
      const parts = await inputPartsFromText(value, [], {
        attachmentOffset: stagedInputParts.length,
      })
      const files = inputFileParts(parts)
      if (!files.length) return value
      return {
        text: inputText(parts),
        apply() {
          stagedInputParts = [...stagedInputParts, ...files]
        },
      }
    },
    onChange: value => reconcileStagedInputParts(value),
    onClose: () => close(),
  })
  const print = text => transcriptRenderer.print(text)
  const setStatus = text => transcriptRenderer.setStatus(text)
  const userPrefix = style('你 >', 'cyan')
  const assistantPrefix = style('qwen-audio >', 'bold')
  const turnStatusDisplay = createTurnStatusDisplay({ print })
  const transcriptDisplay = createTranscriptDisplay({
    onUserDelta: content => transcriptRenderer.update(userPrefix, content),
    onUser: (content, event) => {
      if (typedTranscripts[0] === content) {
        typedTranscripts.shift()
        transcriptRenderer.cancel()
      } else transcriptRenderer.finish(userPrefix, content)
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
      const citations = formatCitationLines(event?.citations)
      if (citations) print(style(citations, 'dim'))
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
    transcriptRenderer.close()
    process.off('SIGINT', handleSigint)
    process.off('SIGTERM', handleSigterm)
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
      socket.send({
        type: 'audio.append',
        audio: chunk.toString('base64'),
      })
    }
  }
  reconcileStagedInputParts = value => {
    const next = stagedInputParts.filter(part => (
      String(value || '').includes(String(part?.source?.text?.value || ''))
    ))
    if (next.length === stagedInputParts.length) return
    stagedInputParts = next
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
    cleanup()
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
        socket.send({
          type: GatewayClientEvent.PLAYBACK_STARTED,
          responseId,
        })
      }
    },
    onEnded: responseId => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send({
          type: GatewayClientEvent.PLAYBACK_ENDED,
          responseId,
        })
      }
    },
    onCancelled: (responseId, reason = '') => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send({
          type: GatewayClientEvent.PLAYBACK_CANCELLED,
          responseId,
          ...(reason ? { reason } : {}),
        })
      }
    },
    onIdle: () => {
      if (!audioMode.captureDuringPlayback) startMicrophone()
    },
  })

  const startMicrophone = () => {
    if (!canStartTuiCapture({
      clientState: gatewayClientState,
      muted,
      closed,
      bridgeExited,
      socketOpen: socket?.readyState === WebSocket.OPEN,
    })) return
    if (setCaptureEnabled(true)) {
      setStatus(`已连接 · 麦克风已开启 · ${audioMode.shortLabel}`)
      print(`[麦克风已开启 · ${inputSampleRate} Hz · ${audioMode.shortLabel}]`)
    }
  }

  const sendTextInput = async text => {
    if (!text.trim()) return
    const referencedParts = stagedInputParts.filter(part => (
      text.includes(String(part?.source?.text?.value || ''))
    ))
    const parts = await inputPartsFromText(text, referencedParts)
    if (socket?.readyState !== WebSocket.OPEN) {
      throw new Error('Gateway 尚未连接')
    }
    socket.send({
      type: GatewayClientEvent.INPUT_MESSAGE,
      parts,
    })
    const transcript = displayInputText(parts)
    stagedInputParts = []
    typedTranscripts.push(transcript)
    transcriptRenderer.finish(userPrefix, transcript)
  }

  const setMuted = value => {
    muted = value
    if (muted) {
      setCaptureEnabled(false)
      setStatus('麦克风已静音 · 语音回复保持开启')
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(microphoneControlEvent(true))
      }
      print(style(
        '[麦克风已静音，语音输入不会被识别；输入 /mute 恢复]',
        'yellow',
      ))
      if (pendingPermissionTasks.size > 0) {
        print(style('[正在等待授权，恢复麦克风后再回答]', 'yellow'))
      }
    } else {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(microphoneControlEvent(false))
      }
      print(style('[麦克风已恢复]', 'green'))
      setStatus('麦克风正在恢复 · 语音回复保持开启')
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
    gatewayClientState = reduceGatewayClientState(gatewayClientState, event)
    if (event.type === GatewayServerEvent.VOICE_READY) {
      const nextRate = Number(event.inputSampleRate) || inputSampleRate
      if (nextRate !== inputSampleRate) {
        print(`${style('[音频配置错误]', 'red')} Gateway 要求 ${nextRate} Hz，`
          + `但音频设备已按 ${inputSampleRate} Hz 启动`)
        close()
        return
      }
      if (gatewayClientState.ownership.state === 'active') startMicrophone()
    }
    if (
      event.type === GatewayServerEvent.VOICE_CONNECTION
      && event.state === 'unavailable'
    ) {
      setCaptureEnabled(false)
      print(`${style('[语音前台连接失败]', 'red')} ${event.message || '请检查前台服务配置'}`)
    }
    if (event.type === GatewayServerEvent.VOICE_OWNERSHIP) {
      if (event.state === 'active') {
        everOwnedVoice = true
        startMicrophone()
      } else if (event.state === 'busy') {
        setCaptureEnabled(false)
        playback.clear()
        const holder = frontendLabel(event.holder)
        if (!everOwnedVoice) {
          print(style(
            `[语音正由${holder}使用；请先关闭当前连接]`,
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
          '[正在等待授权，但麦克风已静音；输入 /mute 恢复后再回答]',
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

  const restoreTasks = tasks => {
    for (const task of tasks || []) {
      if (!['queued', 'running', 'delegated', 'finalizing', 'cancelling'].includes(task.status)
        && task.authorization?.status !== 'pending') continue
      const type = task.authorization?.status === 'pending'
        ? 'task.permission.requested'
        : `task.${task.status}`
      handleGatewayMessage(JSON.stringify({ type, task }))
    }
  }

  const connectGateway = () => {
    if (closed || bridgeExited) return
    const nextClient = new GatewayClient({
      url: websocketUrl(options.url, options.sessionId),
      createSocket: url => new WebSocket(url, { headers }),
      clientType: 'cli',
      clientLabel: 'CLI',
      clientInstanceId: `tui-${process.pid}`,
      capabilities: gatewayReferenceClientCapabilities('cli'),
      reconnect: false,
      configure: () => connectMessage({
        voiceEnabled: true,
        inputEnabled: !muted,
        outputEnabled: true,
      }),
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      onEvent: event => handleGatewayMessage(JSON.stringify(event)),
      onRecovery: recovery => restoreTasks(recovery.tasks),
      onStatus: status => {
        if (socket !== nextClient || closed) return
        if (status.state === 'connected') {
          reconnectDelay = 500
          gatewayClientState = reduceGatewayClientState(gatewayClientState, {
            type: GatewayServerEvent.GATEWAY_CONNECTED,
          })
          setStatus('Gateway 已连接 · 语音服务准备中')
          if (connectedOnce) {
            print(style('[qwen-audio-agent 已重新连接]', 'green'))
          } else {
            connectedOnce = true
            print(
              `${style('qwen-audio-agent Voice TUI', 'bold')} · ${health.realtimeLabel || health.realtimeModelProfile?.label || health.realtimeModel || 'Realtime'} → ${health.backend?.label || health.backend?.kind || 'Gateway'}\n`
              + `${realtimeModelStatusText(health)}\n`
              + `会话：${options.sessionId}\n`
              + `音频：${audioMode.label}\n`
              + `${helpText(audioMode)}\n`,
            )
          }
        } else if (status.state === 'unavailable') {
          if (!closed) print(`${style('[连接错误]', 'red')} ${status.error?.message || '连接失败'}`)
        } else if (status.state === 'recovery_failed') {
          print(style(`[任务状态] ${status.error.message}`, 'yellow'))
        } else if (status.state === 'disconnected') {
          gatewayClientState = reduceGatewayClientState(gatewayClientState, {
            type: GatewayServerEvent.GATEWAY_DISCONNECTED,
          })
          setCaptureEnabled(false)
          playback.clear()
          transcriptDisplay.reset()
          if (closed) {
            print('qwen-audio-agent 连接已关闭。')
          } else if (bridgeExited) {
            cleanup()
          } else {
            setStatus('Gateway 已断开 · 正在自动重连 · /exit 或 Ctrl-C 可退出')
            print(style('[qwen-audio-agent 连接中断，正在重连]', 'yellow'))
            scheduleReconnect()
          }
        }
      },
    })
    socket = nextClient
    nextClient.start()
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
        setStatus('等待 Gateway · 正在自动重连 · /exit 或 Ctrl-C 可退出')
        print(style(`[等待 Gateway] ${error.message}`, 'yellow'))
        scheduleReconnect()
      }
    }, delay)
  }

  handleTerminalLine = async value => {
    const text = String(value || '').trim()
    const [command = ''] = text.split(/\s+/)
    if (isExitCommand(command)) {
      close()
    } else if (['/mute', '/m'].includes(command)) {
      setMuted(!muted)
    } else if (['/interrupt', '/x'].includes(command)) {
      if (!audioMode.manualInterrupt) {
        throw new Error('当前全双工模式支持直接用语音打断，无需手动打断')
      }
      performManualInterrupt({
        playback,
        transcriptRenderer,
        socket,
        startMicrophone,
        print,
      })
    } else if (['/help', '/h'].includes(command)) {
      print(helpText(audioMode))
    } else if (command.startsWith('/')) {
      throw new Error(`未知命令：${command}；输入 /help 查看帮助`)
    } else {
      await sendTextInput(value)
    }
  }

  connectGateway()

  process.once('SIGINT', handleSigint)
  process.once('SIGTERM', handleSigterm)
  await closedPromise
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  const logger = createLogger({
    component: 'tui',
    fileName: 'tui.log',
    consoleEnabled: false,
  })
  logger.info('tui.started')
  runTui()
    .then(() => logger.info('tui.stopped'))
    .catch(error => {
      logger.error('tui.failed', { error })
      process.stderr.write(`qwen-audio-agent TUI 启动失败：${error.message}\n`)
      process.exitCode = 1
    })
}
