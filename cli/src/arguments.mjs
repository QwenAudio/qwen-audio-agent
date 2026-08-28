import { randomUUID } from 'node:crypto'
import {
  backendDefinition,
  backendNames,
  normalizeBackendProtocol,
} from '../../shared/backend-catalog.mjs'

const COMMANDS = new Set([
  'gateway',
  'tui',
  'webui',
  'status',
  'config',
  'setup',
  'install',
  'skill',
])
const GATEWAY_ACTIONS = new Set([
  'run',
  'install',
  'start',
  'stop',
  'restart',
  'status',
  'uninstall',
])
const BACKEND_PERMISSION_MODES = new Set(['native', 'full'])
const TUI_AUDIO_MODES = new Set(['half', 'full'])
const SKILL_ACTIONS = new Set(['install', 'list', 'remove', 'update'])

export function createVoiceSessionId() {
  return `voice-${randomUUID().replaceAll('-', '')}`
}

function nextValue(argv, index, option) {
  const value = argv[index + 1]
  if (!value || value.startsWith('-')) throw new Error(`${option} 缺少参数`)
  return value
}

function cleanOrigin(value, label) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`无效的${label}：${value}`)
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${label}只支持 http 或 https`)
  }
  return url.origin
}

export function parseArguments(argv, env = process.env) {
  const args = [...argv]
  const first = args[0]
  const command = first && !first.startsWith('-') ? args.shift() : 'gateway'
  if (!COMMANDS.has(command)) throw new Error(`未知命令：${command}`)
  const configAction = command === 'config' && args[0] && !args[0].startsWith('-')
    ? args.shift() : ''
  if (command === 'config' && configAction && !['show', 'set'].includes(configAction)) {
    throw new Error(`未知 config 命令：${configAction}`)
  }
  const gatewayAction = command === 'gateway'
    && args[0]
    && !args[0].startsWith('-')
    ? args.shift()
    : command === 'status' ? 'status' : 'run'
  if (command === 'gateway' && !GATEWAY_ACTIONS.has(gatewayAction)) {
    throw new Error(`未知 Gateway 命令：${gatewayAction}`)
  }
  const installTarget = command === 'install'
    && args[0]
    && !args[0].startsWith('-')
    ? args.shift()
    : ''
  const skillAction = command === 'skill' && args[0] && !args[0].startsWith('-')
    ? args.shift()
    : ''
  if (command === 'skill' && !SKILL_ACTIONS.has(skillAction)) {
    throw new Error(
      `skill 需要子命令（可选：${[...SKILL_ACTIONS].join('、')}）`,
    )
  }
  const skillTarget = command === 'skill'
    && ['install', 'remove'].includes(skillAction)
    && args[0]
    && !args[0].startsWith('-')
    ? args.shift()
    : ''
  if (command === 'skill' && skillAction === 'install' && !skillTarget) {
    throw new Error('skill install 需要技能来源（本地目录或 git URL）')
  }
  if (command === 'skill' && skillAction === 'remove' && !skillTarget) {
    throw new Error('skill remove 需要技能名称')
  }

  const options = {
    command,
    configAction,
    realtimeModel: '',
    gatewayAction,
    url: env.QWEN_AUDIO_AGENT_URL || 'http://127.0.0.1:3101',
    sessionId: env.QWEN_AUDIO_AGENT_SESSION_ID || createVoiceSessionId(),
    audioMode: String(
      env.QWEN_AUDIO_AGENT_TUI_AUDIO_MODE || 'half',
    ).toLowerCase(),
    backend: normalizeBackendProtocol(env.AGENT_PROTOCOL),
    backendPermissionMode: String(
      env.QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE || 'native',
    ).toLowerCase(),
    backendAgent: String(
      env.QWEN_AUDIO_AGENT_BACKEND_AGENT || '',
    ).trim(),
    backendUrl: '',
    backendUrlSpecified: false,
    installTarget: '',
    skillAction,
    skillTarget,
    skillNames: [],
    skillList: false,
    openBrowser: true,
    json: false,
    yes: false,
    backendSpecified: false,
    gatewayConfigurationSpecified: false,
  }
  let audioModeSpecified = false

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--url') {
      options.url = nextValue(args, index++, '--url')
      options.gatewayConfigurationSpecified = true
    } else if (argument === '--backend') {
      options.backend = normalizeBackendProtocol(
        nextValue(args, index++, '--backend'),
      )
      options.backendSpecified = true
      options.gatewayConfigurationSpecified = true
    } else if (argument === '--backend-agent') {
      options.backendAgent = nextValue(args, index++, '--backend-agent').trim()
      options.gatewayConfigurationSpecified = true
    } else if (argument === '--backend-permission-mode') {
      options.backendPermissionMode = nextValue(
        args,
        index++,
        '--backend-permission-mode',
      ).toLowerCase()
      options.gatewayConfigurationSpecified = true
    } else if (argument === '--backend-url') {
      options.backendUrl = nextValue(args, index++, '--backend-url')
      options.backendUrlSpecified = true
      options.gatewayConfigurationSpecified = true
    } else if (argument === '--realtime-model') {
      options.realtimeModel = nextValue(args, index++, '--realtime-model')
    } else if (argument === '--session') {
      options.sessionId = nextValue(args, index++, '--session')
    } else if (argument === '--audio-mode') {
      options.audioMode = nextValue(args, index++, '--audio-mode').toLowerCase()
      audioModeSpecified = true
    } else if (argument === '--no-open') options.openBrowser = false
    else if (argument === '--skill') {
      options.skillNames.push(nextValue(args, index++, '--skill'))
    } else if (argument === '--list') options.skillList = true
    else if (argument === '--json') options.json = true
    else if (argument === '--yes' || argument === '-y') options.yes = true
    else if (argument === '--help' || argument === '-h') options.help = true
    else throw new Error(`未知参数：${argument}`)
  }

  if ((command !== 'config' || configAction !== 'set') && options.realtimeModel) {
    throw new Error('--realtime-model 只适用于 config set')
  }
  if (command === 'config' && configAction === 'set' && !options.realtimeModel) {
    throw new Error('config set 需要 --realtime-model')
  }

  if (
    command === 'install'
    && !normalizeBackendProtocol(installTarget)
  ) {
    throw new Error(
      `install 缺少后台名称（可选：${backendNames().join('、')}）`,
    )
  }
  options.installTarget = normalizeBackendProtocol(installTarget)
  if (
    options.installTarget
    && !backendDefinition(options.installTarget)
  ) {
    throw new Error(
      `不支持的后台：${options.installTarget}（可选 ${backendNames().join('、')}）`,
    )
  }
  if (options.installTarget === 'acp') {
    throw new Error('通用 ACP 接入的 Agent 请自行安装，并通过 ACP_COMMAND 配置')
  }
  if (command !== 'install' && options.yes) {
    throw new Error('--yes 只适用于 install')
  }
  const skillInstall = command === 'skill' && skillAction === 'install'
  if (options.skillNames.length && !skillInstall) {
    throw new Error('--skill 只适用于 skill install')
  }
  if (options.skillList && !skillInstall) {
    throw new Error('--list 只适用于 skill install')
  }
  if (options.skillList && options.skillNames.length) {
    throw new Error('--list 与 --skill 不能同时使用')
  }

  const definition = options.backend
    ? backendDefinition(options.backend)
    : null
  if (options.backend && !definition) {
    throw new Error(
      `不支持的后台：${options.backend}（可选 ${backendNames().join('、')}）`,
    )
  }
  if (
    options.backend
    && !BACKEND_PERMISSION_MODES.has(options.backendPermissionMode)
  ) {
    throw new Error(
      `不支持的后台权限模式：${options.backendPermissionMode}`
      + '（可选 native、full）',
    )
  }
  if (command !== 'webui' && !options.openBrowser) {
    throw new Error('--no-open 只适用于 webui')
  }
  if (command !== 'setup' && options.json) {
    throw new Error('--json 只适用于 setup')
  }
  if (command !== 'tui' && audioModeSpecified) {
    throw new Error('--audio-mode 只适用于 tui')
  }
  if (command === 'tui' && !TUI_AUDIO_MODES.has(options.audioMode)) {
    throw new Error(
      `不支持的音频模式：${options.audioMode}（可选 half、full）`,
    )
  }
  if (
    command === 'gateway'
    && !['run', 'status'].includes(options.gatewayAction)
    && options.gatewayConfigurationSpecified
  ) {
    throw new Error(
      'Gateway 后台服务从 config.env 读取配置；请先修改配置，再执行服务命令',
    )
  }

  options.url = cleanOrigin(options.url, ' Gateway URL')
  const configuredBackendUrl = definition?.baseUrlEnvironment
    ? env[definition.baseUrlEnvironment] || definition.defaultBaseUrl
    : ''
  options.backendUrl = definition?.baseUrlEnvironment
    ? cleanOrigin(options.backendUrl || configuredBackendUrl, '后台地址')
    : ''
  if (
    !['setup', 'install'].includes(command)
    && definition
    && options.backendPermissionMode === 'full'
    && !definition.supportsFullPermission
  ) {
    throw new Error(
      `${definition.label} 不支持 Gateway 统一最高权限模式`,
    )
  }
  options.sessionId = String(options.sessionId || '').trim()
  if (!options.sessionId) throw new Error('--session 不能为空')
  return options
}

export function helpText() {
  return [
    'qwenaudio',
    '',
    '用法：',
    '  qwenaudio [gateway] [run] [选项]  前台运行 Gateway（默认）',
    '  qwenaudio gateway install         安装并启动后台常驻服务',
    '  qwenaudio gateway start           启动后台服务',
    '  qwenaudio gateway status          查看 Gateway 状态',
    '  qwenaudio gateway stop            停止后台服务',
    '  qwenaudio gateway restart         重启后台服务',
    '  qwenaudio gateway uninstall       移除后台常驻服务',
    '  qwenaudio tui [选项]         连接现有 Gateway 的终端界面',
    '  qwenaudio webui [选项]       打开现有 Gateway 的 WebUI',
    '  qwenaudio status [选项]      gateway status 的兼容别名',
    '  qwenaudio config             显示用户配置文件位置',
    '  qwenaudio config show        显示有效 Realtime 模型（不含凭据）',
    '  qwenaudio config set --realtime-model ID  更新 Realtime 模型',
    '  qwenaudio setup [选项]       只读检查后台 Agent 接入准备情况',
    '  qwenaudio install NAME        一键安装后台 Agent（含所需 ACP 适配器）',
    '  qwenaudio skill install SRC --skill NAME  安装技能到所有后台（经 skills.sh）',
    '  qwenaudio skill install SRC --list         列出来源中可安装的技能',
    '  qwenaudio skill list          查看已安装技能',
    '  qwenaudio skill remove NAME   移除技能',
    '  qwenaudio skill update        更新已安装技能',
    '',
    'Gateway 选项：',
    '  --url URL              Gateway 地址（默认 http://127.0.0.1:3101）',
    `  --backend NAME         可选：${backendNames().join('、')} 或 none；不设置或使用 none 时仅前台聊天`,
    '  --backend-permission-mode MODE  native（默认）或 full（最高权限）',
    '  --backend-url URL      后台 Server 地址',
    '  --backend-agent ID     指定协调 Agent',
    '',
    'Setup 选项：',
    '  --backend NAME         只检查指定后台；默认检查全部后台',
    '  --json                 输出供桌面版或脚本使用的 JSON',
    '',
    'Install 选项：',
    `  NAME                   可选：${backendNames().filter(name => name !== 'acp').join('、')}；不含通用 acp（需自行安装）`,
    '  --yes, -y              脚本类安装步骤不再逐个确认（谨慎使用）',
    '',
    'Skill 选项（底层由 skills.sh 完成，自动覆盖全部后台 Agent）：',
    '  SRC                    来源：owner/repo、git URL、GitHub tree URL 或技能页 URL',
    '  --skill NAME           指定要安装的技能（可多次）',
    '  --list                 只列出来源内可安装的技能，不安装',
    '',
    '界面选项：',
    '  --session ID           复用指定语音会话',
    '  --audio-mode MODE      Linux / Windows 使用 half（默认）或 full',
    '  --no-open              WebUI 只打印地址，不打开浏览器',
    '  -h, --help             显示帮助',
    '',
    'TUI 按键：',
    '  x                      半双工模式下手动打断当前回复',
    '  m                      静音 / 恢复麦克风',
    '  h                      在 TUI 内显示帮助',
    '  q                      退出 TUI',
  ].join('\n')
}
