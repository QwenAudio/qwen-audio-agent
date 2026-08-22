import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  constants,
  copyFileSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { backendDefinitions } from './backend-catalog.mjs'
import { resolveRealtimeFrontendConfiguration } from './realtime-provider-catalog.mjs'

const SECRET_KEY = 'QWEN_AUDIO_AGENT_AUTH_SECRET'
const USER_CONFIG_TEMPLATE = [
  '# qwen-audio-agent 用户配置',
  'DASHSCOPE_API_KEY=',
  'QWEN_AUDIO_REALTIME_PROVIDER=dashscope',
  '# Hugging Face speech-to-speech：将上一行改为 speech-to-speech，并设置服务地址',
  '# SPEECH_TO_SPEECH_REALTIME_URL=ws://127.0.0.1:8765/v1/realtime',
  '',
  '# 可选：选择后台 Agent；留空时仅使用前台实时语音聊天',
  '# 可选 openclaw、opencode、qoder、qwen、kimi、hermes、codebuddy、codex、claude、deepseek、pi、acp 或 none',
  'AGENT_PROTOCOL=',
  '# 权限模式：native（后台自行询问）或 full（最高权限；仅支持安全映射的后端）',
  '# Pi 没有权限审批机制，无论配置什么都始终生效 full',
  '# QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE=native',
  '# 可选：显式覆盖后台模型；留空时使用 Agent 原有模型',
  '# QWEN_AUDIO_AGENT_BACKEND_MODEL=',
  '# 可选：QWEN_AUDIO_AGENT_BACKEND_AGENT=协调 Agent ID',
  '# Kimi Code 可复用原生登录，或设置官方 KIMI_MODEL_* 临时模型变量',
  '# DeepSeek（Harness Developer Preview）：DEEPSEEK_API_KEY=your-key',
  '# 通用 ACP：ACP_COMMAND=your-agent，ACP_ARGS=["--acp"]',
  '# 通用 ACP 如需额外环境变量：QWEN_AUDIO_AGENT_ACP_FORWARD_ENV=NAME_A,NAME_B',
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

export function userConfigDirectory(
  env = process.env,
  homeDirectory = homedir(),
) {
  if (env.QWAUDIO_CONFIG_DIR) return resolve(env.QWAUDIO_CONFIG_DIR)
  const base = env.XDG_CONFIG_HOME
    ? resolve(env.XDG_CONFIG_HOME)
    : resolve(homeDirectory, '.config')
  return resolve(base, 'qwaudio')
}

// 资产目录：配置、身份、记忆、清单与共享 workspace 等"用户资产"的归属地。
// 默认与运行时目录（configDirectory）相同；桌面版把它指向 CLI 的用户目录，
// 让两种形态共享同一份资产，而 tasks/logs/锁等运行时状态仍按形态隔离
// （参照 Qoder IDE 与 qodercli 的目录分层）。
export function userDataDirectory(
  env = process.env,
  homeDirectory = homedir(),
) {
  if (env.QWAUDIO_DATA_DIR) return resolve(env.QWAUDIO_DATA_DIR)
  return userConfigDirectory(env, homeDirectory)
}

function ensureGeneratedSecret(env, configDirectory) {
  if (env[SECRET_KEY]) return { generated: false, statePath: null }
  const statePath = resolve(configDirectory, 'state.env')
  // An empty shell assignment must not mask the persisted local identity.
  delete env[SECRET_KEY]
  loadFile(statePath, env)
  if (env[SECRET_KEY]) {
    try {
      chmodSync(statePath, 0o600)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    return { generated: false, statePath }
  }

  mkdirSync(configDirectory, { recursive: true, mode: 0o700 })
  const secret = randomBytes(32).toString('hex')
  try {
    writeFileSync(statePath, `${SECRET_KEY}=${secret}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    loadFile(statePath, env)
    if (!env[SECRET_KEY]) {
      throw new Error(`自动生成的本地认证配置无效：${statePath}`)
    }
    return { generated: false, statePath }
  }
  env[SECRET_KEY] = secret
  return { generated: true, statePath }
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

function ensureUserModel(configDirectory) {
  const userModelPath = resolve(configDirectory, 'USER.md')
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

function ensureLongTermMemory(configDirectory) {
  const memoryPath = resolve(configDirectory, 'MEMORY.md')
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

function migrateLegacyMemory({
  legacyPath,
  memoryPath,
  userModelPath,
  ownerId,
  configDirectory,
}) {
  const markerPath = resolve(configDirectory, 'state/frontend-memory-markdown-v1')
  try {
    lstatSync(markerPath)
    return false
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(legacyPath, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return false
    throw error
  }
  const users = parsed?.users && typeof parsed.users === 'object' ? parsed.users : {}
  const selected = users[ownerId] || Object.values(users)[0] || {}
  const values = Object.values(selected).filter(entry => String(entry?.value || '').trim())
  const memory = values.filter(entry => !['user', 'profile', 'rules'].includes(entry.scope))
  const user = values.filter(entry => ['user', 'profile', 'rules'].includes(entry.scope))
  const appendMigrated = (path, heading, entries) => {
    if (!entries.length) return
    const current = readFileSync(path, 'utf8').trimEnd()
    if (current.includes(heading)) return
    const block = [
      '',
      heading,
      '',
      ...entries.map(entry => `- ${String(entry.value).replace(/\s+/g, ' ').trim()}`),
      '',
    ].join('\n')
    writeFileSync(path, `${current}${block}`, { encoding: 'utf8', mode: 0o600 })
    chmodSync(path, 0o600)
  }
  appendMigrated(userModelPath, '## 从旧版本迁移的用户信息', user)
  appendMigrated(memoryPath, '## 从旧版本迁移的长期记忆', memory)
  mkdirSync(dirname(markerPath), { recursive: true, mode: 0o700 })
  writeFileSync(markerPath, `${new Date().toISOString()}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  return Boolean(user.length || memory.length)
}

// 所有后台 Agent 共享同一个默认 workspace。历史上按后台隔离（workspaces/<id>）
// 是为了各自的 AGENTS.md 指令模板，该机制已被 session 级指令注入取代；共享目录
// 让用户切换后台时能无缝继续同一份工作，也让 SKILL 等资产只需同步到一处。
export function defaultBackendWorkspace(configDirectory) {
  return resolve(configDirectory, 'workspace')
}

function resolveBackendWorkspaces(env, root, configDirectory) {
  return Object.fromEntries(backendDefinitions()
    .filter(definition => definition.workspaceEnvironment)
    .map(definition => {
      const configured = env[definition.workspaceEnvironment]
      return [definition.id, {
        directory: configured
          ? resolve(root, configured)
          : defaultBackendWorkspace(configDirectory),
        environment: definition.workspaceEnvironment,
        managed: !configured,
      }]
    }))
}

// 旧版本按后台隔离的 workspaces/<id>/ 目录里可能有用户文件。只提示位置，
// 不自动迁移、不删除，由用户决定是否手动移动到共享 workspace。
function collectLegacyWorkspaceNotices(configDirectory, sharedWorkspace) {
  const notices = []
  for (const definition of backendDefinitions()) {
    if (!definition.workspaceEnvironment) continue
    const legacyDirectory = resolve(
      configDirectory,
      `workspaces/${definition.id}`,
    )
    let entries
    try {
      entries = readdirSync(legacyDirectory)
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
      continue
    }
    if (entries.length) {
      notices.push({
        backend: definition.id,
        legacyDirectory,
        sharedWorkspace,
      })
    }
  }
  return notices
}

function codeBuddyModelName(env) {
  const configured = String(
    env.QWEN_AUDIO_AGENT_BACKEND_MODEL || '',
  ).trim()
  const separator = configured.indexOf('/')
  return separator >= 0 ? configured.slice(separator + 1) : configured
}

function codeBuddyTemplateContent(templatePath, model) {
  const template = JSON.parse(readFileSync(templatePath, 'utf8'))
  const defaultModel = String(template.models?.[0]?.id || '').trim()
  if (!defaultModel) {
    throw new Error(`CodeBuddy 模型模板缺少默认模型：${templatePath}`)
  }
  template.models = template.models.map(entry => (
    entry.id === defaultModel
      ? {
          ...entry,
          id: model,
          ...(entry.name ? {
            name: model === defaultModel ? entry.name : model,
          } : {}),
        }
      : entry
  ))
  if (Array.isArray(template.availableModels)) {
    template.availableModels = template.availableModels.map(id => (
      id === defaultModel ? model : id
    ))
  }
  return `${JSON.stringify(template, null, 2)}\n`
}

function ensureCodeBuddyTemplate(templatePath, targetPath, env) {
  mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 })
  const model = codeBuddyModelName(env)
  if (!model) {
    let current
    try {
      current = readFileSync(targetPath, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
    try {
      const currentModel = String(
        JSON.parse(current).models?.[0]?.id || '',
      ).trim()
      if (
        currentModel
        && current === codeBuddyTemplateContent(templatePath, currentModel)
      ) {
        unlinkSync(targetPath)
      }
    } catch {
      // Preserve malformed or manually edited user configuration.
    }
    return null
  }
  const desired = codeBuddyTemplateContent(templatePath, model)
  try {
    writeFileSync(targetPath, desired, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const current = readFileSync(targetPath, 'utf8')
    let generated = false
    try {
      const currentModel = String(
        JSON.parse(current).models?.[0]?.id || '',
      ).trim()
      generated = Boolean(currentModel) && current === codeBuddyTemplateContent(
        templatePath,
        currentModel,
      )
    } catch {
      // Preserve malformed or manually edited user configuration.
    }
    if (generated && current !== desired) {
      writeFileSync(targetPath, desired, {
        encoding: 'utf8',
        mode: 0o600,
      })
    }
  }
  chmodSync(targetPath, 0o600)
  return targetPath
}

function migratePrivateFile(legacyPath, targetPath) {
  try {
    lstatSync(targetPath)
    return false
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  try {
    if (!lstatSync(legacyPath).isFile()) return false
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }

  try {
    linkSync(legacyPath, targetPath)
    unlinkSync(legacyPath)
  } catch (error) {
    if (['EEXIST', 'ENOENT'].includes(error.code)) return false
    if (error.code !== 'EXDEV') throw error
    try {
      copyFileSync(legacyPath, targetPath, constants.COPYFILE_EXCL)
      unlinkSync(legacyPath)
    } catch (copyError) {
      if (copyError.code === 'EEXIST') return false
      throw copyError
    }
  }
  chmodSync(targetPath, 0o600)
  return true
}

export function loadRuntimeEnvironment({
  root,
  env = process.env,
  homeDirectory = homedir(),
  generateSecret = true,
  prepareBackendRuntime = true,
  readOnly = false,
} = {}) {
  if (!root) throw new Error('loadRuntimeEnvironment requires root')
  const configDirectory = userConfigDirectory(env, homeDirectory)
  // 资产（配置/身份/记忆/清单/workspace）从资产目录读写；tasks、logs、
  // 实例锁等运行时状态留在 configDirectory。两者默认相同，桌面版分离。
  const dataDirectory = userDataDirectory(env, homeDirectory)
  const candidates = [
    resolve(root, '.env.local'),
    resolve(root, '.env'),
    resolve(dataDirectory, 'config.env'),
  ]
  const loadedFiles = candidates.filter(path => loadFile(path, env))
  if (!readOnly) {
    mkdirSync(configDirectory, { recursive: true, mode: 0o700 })
    if (dataDirectory !== configDirectory) {
      mkdirSync(dataDirectory, { recursive: true, mode: 0o700 })
    }
  }
  const configPath = readOnly
    ? resolve(dataDirectory, 'config.env')
    : ensureUserConfig(dataDirectory)
  const userModelPath = readOnly
    ? resolve(dataDirectory, 'USER.md')
    : ensureUserModel(dataDirectory)
  const assistantProfilePath = readOnly
    ? resolve(dataDirectory, 'ASSISTANT.md')
    : ensureAssistantProfile(
        dataDirectory,
        resolve(root, 'config/frontend-agent/ASSISTANT.md'),
      )
  const frontendMemoryPath = readOnly
    ? resolve(dataDirectory, 'MEMORY.md')
    : ensureLongTermMemory(dataDirectory)
  const legacyFrontendMemoryPath = resolve(dataDirectory, 'frontend-memory.json')
  const frontendNotesPath = resolve(dataDirectory, 'frontend-notes.json')
  const taskStatePath = resolve(configDirectory, 'tasks.json')
  const backendWorkspaces = resolveBackendWorkspaces(
    env,
    root,
    dataDirectory,
  )
  const sharedWorkspace = defaultBackendWorkspace(dataDirectory)
  const workspace = id => backendWorkspaces[id]?.directory || ''
  const openCodeWorkspace = workspace('opencode')
  const openClawWorkspace = workspace('openclaw')
  const qoderWorkspace = workspace('qoder')
  const qwenCodeWorkspace = workspace('qwen')
  const kimiWorkspace = workspace('kimi')
  const hermesWorkspace = workspace('hermes')
  const codeBuddyWorkspace = workspace('codebuddy')
  const codexWorkspace = workspace('codex')
  const claudeWorkspace = workspace('claude')
  const piWorkspace = workspace('pi')
  const acpWorkspace = workspace('acp')
  const openClawStateDirectory = env.QWEN_AUDIO_AGENT_OPENCLAW_STATE_DIR
    ? resolve(root, env.QWEN_AUDIO_AGENT_OPENCLAW_STATE_DIR)
    : resolve(configDirectory, 'backends/openclaw/state')
  let migratedFiles = []
  let legacyWorkspaceNotices = []
  if (prepareBackendRuntime && !readOnly) {
    migratePrivateFile(
      resolve(root, 'runtime/frontend-memory.json'),
      legacyFrontendMemoryPath,
    )
    if (migrateLegacyMemory({
      legacyPath: legacyFrontendMemoryPath,
      memoryPath: frontendMemoryPath,
      userModelPath,
      ownerId: env.QWEN_AUDIO_AGENT_PERSONAL_OWNER_ID || 'user_personal',
      configDirectory: dataDirectory,
    })) {
      migratedFiles.push(frontendMemoryPath, userModelPath)
    }
    for (const entry of Object.values(backendWorkspaces)) {
      if (entry.managed) {
        mkdirSync(entry.directory, { recursive: true, mode: 0o700 })
      }
      env[entry.environment] = entry.directory
    }
    // 旧的按后台隔离目录可能分别留在运行时目录与资产目录（桌面版分离后）。
    legacyWorkspaceNotices = [...new Set([configDirectory, dataDirectory])]
      .flatMap(directory => collectLegacyWorkspaceNotices(
        directory,
        sharedWorkspace,
      ))
    if (backendWorkspaces.codebuddy?.managed) {
      ensureCodeBuddyTemplate(
        resolve(root, 'config/codebuddy/workspace/.codebuddy/models.json'),
        resolve(codeBuddyWorkspace, '.codebuddy/models.json'),
        env,
      )
    }
    mkdirSync(openClawStateDirectory, { recursive: true, mode: 0o700 })
    env.QWEN_AUDIO_AGENT_OPENCLAW_STATE_DIR = openClawStateDirectory
    migratedFiles.push(...[
      [resolve(root, 'runtime/tasks.json'), taskStatePath],
    ].filter(([legacyPath, targetPath]) => (
      migratePrivateFile(legacyPath, targetPath)
    )).map(([, targetPath]) => targetPath))
  }
  const secret = generateSecret && !readOnly
    ? ensureGeneratedSecret(env, dataDirectory)
    : { generated: false, statePath: null }
  return {
    configDirectory,
    dataDirectory,
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
    kimiWorkspace,
    hermesWorkspace,
    codeBuddyWorkspace,
    codexWorkspace,
    claudeWorkspace,
    piWorkspace,
    acpWorkspace,
    openClawStateDirectory,
    migratedFiles,
    legacyWorkspaceNotices,
    loadedFiles,
    generatedSecret: secret.generated,
    statePath: secret.statePath,
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
