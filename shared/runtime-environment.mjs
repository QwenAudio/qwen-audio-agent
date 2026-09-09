import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { resolveRuntimePaths, runtimePathEnvironment, userConfigDirectory } from './runtime-paths.mjs'
import { backendDefinitions } from './backend/catalog.mjs'
import { resolveRealtimeFrontendConfiguration } from './realtime-provider-catalog.mjs'

const SECRET_KEY = 'QWEN_AUDIO_AGENT_AUTH_SECRET'
const USER_CONFIG_TEMPLATE = [
  '# qwen-audio-agent 用户配置',
  'DASHSCOPE_API_KEY=',
  'QWEN_AUDIO_REALTIME_PROVIDER=dashscope',
  '# Hugging Face speech-to-speech：将上一行改为 speech-to-speech，并设置服务地址',
  '# SPEECH_TO_SPEECH_REALTIME_URL=ws://127.0.0.1:8765/v1/realtime',
  '# MiniCPM-o 4.5：将 Provider 改为 minicpm-o，并先启动本地 Realtime 服务',
  '# MINICPM_O_REALTIME_URL=ws://127.0.0.1:8006/v1/realtime?mode=audio',
  '# MINICPM_O_AUTH_TOKEN=',
  '',
  '# 可选目录：QWAUDIO_DATA_DIR / QWAUDIO_STATE_DIR / QWAUDIO_CACHE_DIR',
  '# 所有后台默认工作区：QWAUDIO_WORKSPACE=/absolute/path/to/projects',
  '',
  '# 可选：选择后台 Agent；留空时仅使用前台实时语音聊天',
  '# 可选 openclaw、opencode、qoder、qwen、minimax、kimi、hermes、codebuddy、codex、claude、deepseek、pi、acp 或 none',
  'AGENT_PROTOCOL=',
  '# 权限模式：native（后台自行询问）或 full（最高权限；仅支持安全映射的后端）',
  '# Pi 没有权限审批机制，无论配置什么都始终生效 full',
  '# QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE=native',
  '# 可选：通过 ACP 标准覆盖 Session 模型；OpenCode/OpenClaw 托管初始化也会使用',
  '# 留空时完全沿用 Agent 原有模型；后台未声明 ACP 模型选项时显式覆盖会失败',
  '# QWEN_AUDIO_AGENT_BACKEND_MODEL=',
  '# 可选：QWEN_AUDIO_AGENT_BACKEND_AGENT=协调 Agent ID',
  '# Kimi Code 可复用原生登录，或设置官方 KIMI_MODEL_* 临时模型变量',
  '# DeepSeek（Harness Developer Preview）：DEEPSEEK_API_KEY=your-key',
  '# 通用 ACP：ACP_COMMAND=your-agent，ACP_ARGS=["--acp"]',
  '# 通用 ACP 如需额外环境变量：QWEN_AUDIO_AGENT_ACP_FORWARD_ENV=NAME_A,NAME_B',
  '',
  '# 可选：前台 MCP 配置文件的绝对路径；MCP 引用的持久变量也写在本文件中',
  '# QWEN_AUDIO_FRONTEND_MCP_CONFIG=/absolute/path/to/frontend-mcp.json',
  '',
  '# 可选记忆 Provider：markdown（默认）或 voicemem；VoiceMem 需先安装 Python 依赖',
  '# QWEN_AUDIO_MEMORY_PROVIDER=voicemem',
  '# VOICEMEM_INPUT_MODE=text',
  '# VOICEMEM_PYTHON=/absolute/path/to/voicemem-python',
  '# VOICEMEM_SIDECAR=/absolute/path/to/voicemem-sidecar.py',
  '',
  '# 可选远程 Client 接入；Gateway 默认仍只监听 127.0.0.1',
  '# 使用已安装并登录的系统 Tailscale Serve：QWEN_AUDIO_GATEWAY_TAILNET=1',
  '# 或声明用户自行维护的 HTTPS Origin：QWEN_AUDIO_GATEWAY_PUBLIC_URL=https://voice.example.com',
  '# QWEN_AUDIO_GATEWAY_ACCESS_TOKEN=至少24字符的随机密钥',
  '# QWEN_AUDIO_AGENT_ALLOWED_ORIGINS=https://voice.example.com',
  '',
  '# 可选日志设置：默认 info、单文件 10 MiB、保留 5 份',
  '# QWEN_AUDIO_LOG_LEVEL=info',
  '# QWEN_AUDIO_LOG_MAX_BYTES=10485760',
  '# QWEN_AUDIO_LOG_MAX_FILES=5',
  '',
].join('\n')
const USER_MODEL_TEMPLATE = [
  '# USER',
  '',
  '<!--',
  '这是当前用户对助手的长期个性化覆盖。只填写用户明确设定的称呼、关系、表达偏好和默认做法。',
  '它可以覆盖 ASSISTANT.md 的默认人设，但不能覆盖 PROMPT.md 的运行规则。',
  '仅用于理解用户、不应直接支配行为的事实请写入 MEMORY.md。',
  '不要在这里保存密码、API Key、验证码或令牌。',
  '-->',
  '',
  '## 称呼与关系',
  '',
  '<!-- 例如：- 助手称呼用户：老大 -->',
  '<!-- 例如：- 当前用户称呼助手：小舟 -->',
  '',
  '## 交互偏好',
  '',
  '<!-- 例如：- 默认使用简短、自然的中文回答 -->',
  '',
].join('\n')
const MEMORY_TEMPLATE = [
  '# MEMORY',
  '',
  '<!--',
  '这里保存语音助手从对话中确认的长期背景信息。内容使用普通 Markdown。',
  '称呼和交互偏好请写入 USER.md；不要保存密码、API Key、验证码或令牌。',
  '-->',
  '',
].join('\n')

function loadFile(path, env) {
  let values
  try {
    values = parseEnv(readFileSync(path, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
  for (const [key, value] of Object.entries(values)) {
    if (env[key] === undefined) env[key] = value
  }
  return true
}

function ensureGeneratedSecret(env, configDirectory) {
  if (env[SECRET_KEY]) return { generated: false, identityPath: null }
  const identityPath = resolve(configDirectory, 'identity.env')
  // An empty shell assignment must not mask the persisted local identity.
  delete env[SECRET_KEY]
  loadFile(identityPath, env)
  if (env[SECRET_KEY]) {
    try {
      chmodSync(identityPath, 0o600)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    return { generated: false, identityPath }
  }

  mkdirSync(configDirectory, { recursive: true, mode: 0o700 })
  const secret = randomBytes(32).toString('hex')
  try {
    writeFileSync(identityPath, `${SECRET_KEY}=${secret}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    loadFile(identityPath, env)
    if (!env[SECRET_KEY]) {
      throw new Error(`自动生成的本地认证配置无效：${identityPath}`)
    }
    return { generated: false, identityPath }
  }
  env[SECRET_KEY] = secret
  return { generated: true, identityPath }
}

function ensureUserConfig(configDirectory) {
  const configPath = resolve(configDirectory, 'config.env')
  try {
    writeFileSync(configPath, USER_CONFIG_TEMPLATE, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  try {
    chmodSync(configPath, 0o600)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  return configPath
}

function ensureUserModel(dataDirectory) {
  const userModelPath = resolve(dataDirectory, 'USER.md')
  try {
    writeFileSync(userModelPath, USER_MODEL_TEMPLATE, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  try {
    chmodSync(userModelPath, 0o600)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  return userModelPath
}

function ensureAssistantProfile(configDirectory, templatePath) {
  const targetPath = resolve(configDirectory, 'ASSISTANT.md')
  let template
  try {
    template = readFileSync(templatePath, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return templatePath
  }
  try {
    writeFileSync(targetPath, template, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  try {
    chmodSync(targetPath, 0o600)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  return targetPath
}

function ensureLongTermMemory(dataDirectory) {
  const memoryPath = resolve(dataDirectory, 'MEMORY.md')
  try {
    writeFileSync(memoryPath, MEMORY_TEMPLATE, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  try {
    chmodSync(memoryPath, 0o600)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  return memoryPath
}

function resolveBackendWorkspaces(env, root, sharedWorkspace) {
  return Object.fromEntries(backendDefinitions()
    .filter(definition => definition.workspaceEnvironment)
    .map(definition => {
      const configured = env[definition.workspaceEnvironment]
      return [definition.id, {
        directory: configured
          ? resolve(root, configured)
          : sharedWorkspace,
        environment: definition.workspaceEnvironment,
        managed: !configured,
      }]
    }))
}

export function loadRuntimeEnvironment({
  root,
  env = process.env,
  homeDirectory = homedir(),
  defaultStateDirectory,
  generateSecret = true,
  prepareBackendRuntime = true,
  readOnly = false,
} = {}) {
  if (!root) throw new Error('loadRuntimeEnvironment requires root')
  const configDirectory = userConfigDirectory(env, homeDirectory)
  const candidates = [
    resolve(root, '.env.local'),
    resolve(root, '.env'),
    resolve(configDirectory, 'config.env'),
  ]
  const loadedFiles = candidates.filter(path => loadFile(path, env))
  // Config location is bootstrap input; directory settings inside that file
  // are resolved only after loading it, then forwarded as absolute paths.
  const paths = resolveRuntimePaths({
    env: { ...env, QWAUDIO_CONFIG_DIR: configDirectory },
    homeDirectory,
    baseDirectory: root,
    defaultStateDirectory,
  })
  const { dataDirectory, stateDirectory, sharedWorkspace } = paths
  // Normalize only explicit settings. Do not turn defaults into sticky process
  // overrides: another embedded instance may use a different config directory.
  for (const [key, value] of Object.entries(runtimePathEnvironment(paths))) {
    if (env[key]) env[key] = value
  }
  if (!readOnly) {
    for (const directory of new Set([configDirectory, dataDirectory, stateDirectory])) {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
    }
  }
  const configPath = readOnly
    ? resolve(configDirectory, 'config.env')
    : ensureUserConfig(configDirectory)
  const userModelPath = readOnly
    ? resolve(dataDirectory, 'USER.md')
    : ensureUserModel(dataDirectory)
  const assistantProfilePath = readOnly
    ? resolve(configDirectory, 'ASSISTANT.md')
    : ensureAssistantProfile(
        configDirectory,
        resolve(root, 'config/frontend-agent/ASSISTANT.md'),
      )
  const frontendMemoryPath = readOnly
    ? resolve(dataDirectory, 'MEMORY.md')
    : ensureLongTermMemory(dataDirectory)
  const frontendNotesPath = resolve(dataDirectory, 'frontend-notes.json')
  const taskStatePath = resolve(stateDirectory, 'tasks.json')
  const backendWorkspaces = resolveBackendWorkspaces(
    env,
    root,
    sharedWorkspace,
  )
  const workspace = id => backendWorkspaces[id]?.directory || ''
  const openCodeWorkspace = workspace('opencode')
  const openClawWorkspace = workspace('openclaw')
  const qoderWorkspace = workspace('qoder')
  const qwenCodeWorkspace = workspace('qwen')
  const minimaxWorkspace = workspace('minimax')
  const kimiWorkspace = workspace('kimi')
  const hermesWorkspace = workspace('hermes')
  const codeBuddyWorkspace = workspace('codebuddy')
  const codexWorkspace = workspace('codex')
  const claudeWorkspace = workspace('claude')
  const piWorkspace = workspace('pi')
  const acpWorkspace = workspace('acp')
  const openClawStateDirectory = env.QWEN_AUDIO_AGENT_OPENCLAW_STATE_DIR
    ? resolve(root, env.QWEN_AUDIO_AGENT_OPENCLAW_STATE_DIR)
    : resolve(stateDirectory, 'backends/openclaw')
  if (prepareBackendRuntime && !readOnly) {
    for (const entry of Object.values(backendWorkspaces)) {
      if (entry.managed) {
        mkdirSync(entry.directory, { recursive: true, mode: 0o700 })
      }
      env[entry.environment] = entry.directory
    }
    mkdirSync(openClawStateDirectory, { recursive: true, mode: 0o700 })
    env.QWEN_AUDIO_AGENT_OPENCLAW_STATE_DIR = openClawStateDirectory
  }
  const secret = generateSecret && !readOnly
    ? ensureGeneratedSecret(env, configDirectory)
    : { generated: false, identityPath: null }
  return {
    ...paths,
    configPath,
    assistantProfilePath,
    userModelPath,
    frontendMemoryPath,
    frontendNotesPath,
    taskStatePath,
    sharedWorkspace,
    openCodeWorkspace,
    openClawWorkspace,
    qoderWorkspace,
    qwenCodeWorkspace,
    minimaxWorkspace,
    kimiWorkspace,
    hermesWorkspace,
    codeBuddyWorkspace,
    codexWorkspace,
    claudeWorkspace,
    piWorkspace,
    acpWorkspace,
    openClawStateDirectory,
    loadedFiles,
    generatedSecret: secret.generated,
    identityPath: secret.identityPath,
  }
}

export function hasDashScopeCredential(env = process.env) {
  return Boolean(
    env.QWEN_AUDIO_REALTIME_API_KEY
    || env.DASHSCOPE_API_KEY,
  )
}

export function requireDashScopeCredential(env = process.env) {
  if (hasDashScopeCredential(env)) return
  throw new Error(
    '缺少 DASHSCOPE_API_KEY。请运行 qwenaudio config 查看配置文件位置。',
  )
}

export function requireRealtimeFrontendConfiguration(env = process.env) {
  const frontend = resolveRealtimeFrontendConfiguration(env)
  if (frontend.configured) return
  throw new Error(frontend.missingConfigurationMessage)
}
