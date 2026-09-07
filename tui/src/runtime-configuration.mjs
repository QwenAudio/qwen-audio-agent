import { GatewayClientEvent } from '../../shared/realtime-events.mjs'
import { clientInputCapabilities } from '../../shared/client-input-capabilities.mjs'

const AUDIO_MODES = new Set(['half', 'full'])

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
    accessToken: String(
      env.QWEN_AUDIO_GATEWAY_CLIENT_TOKEN
      || env.QWEN_AUDIO_AGENT_ACCESS_TOKEN
      || '',
    ).trim(),
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
  accessToken = '',
  fetchImpl = fetch,
  timeoutMs = 5000,
} = {}) {
  let response
  try {
    response = await fetchImpl(`${baseUrl}/api/health`, {
      headers: accessToken
        ? { Authorization: `Bearer ${accessToken}` }
        : {},
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
