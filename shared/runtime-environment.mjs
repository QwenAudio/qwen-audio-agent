import { randomBytes } from 'node:crypto'
import {
  constants,
  copyFileSync,
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { parseEnv } from 'node:util'
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
  '# 可选 openclaw、opencode、qoder、kimi、hermes、codebuddy、codex、claude、acp 或 none',
  'AGENT_PROTOCOL=',
  '# 权限模式：native（后台自行询问）或 full（最高权限；仅支持安全映射的后端）',
  '# QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE=native',
  '# 可选：显式覆盖后台模型；留空时使用 Agent 原有模型',
  '# QWEN_AUDIO_AGENT_BACKEND_MODEL=',
  '# 可选：QWEN_AUDIO_AGENT_BACKEND_AGENT=协调 Agent ID',
  '# Kimi Code 可复用原生登录，或设置官方 KIMI_MODEL_* 临时模型变量',
  '# 通用 ACP：ACP_COMMAND=your-agent，ACP_ARGS=["--acp"]',
  '',
  '# 可选日志设置：默认 info、单文件 10 MiB、保留 5 份',
  '# QWEN_AUDIO_LOG_LEVEL=info',
  '# QWEN_AUDIO_LOG_MAX_BYTES=10485760',
  '# QWEN_AUDIO_LOG_MAX_FILES=5',
  '',
].join('\n')
const USER_PROFILE_TEMPLATE = [
  '# USER',
  '',
  '<!--',
  '这是你的本地长期档案。只填写希望语音助手长期了解的稳定信息。',
  '不要在这里保存密码、API Key、验证码或令牌。',
  '-->',
  '',
  '## 基本信息',
  '',
  '- 称呼：',
  '- 所在地：',
  '',
  '## 长期偏好',
  '',
  '- ',
  '',
  '## 常用项目',
  '',
  '- ',
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

function ensureUserProfile(configDirectory) {
  const profilePath = resolve(configDirectory, 'USER.md')
  try {
    writeFileSync(profilePath, USER_PROFILE_TEMPLATE, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  try {
    chmodSync(profilePath, 0o600)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  return profilePath
}

function ensureManagedWorkspace(directory, templatePath) {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const instructionsPath = resolve(directory, 'AGENTS.md')
  try {
    copyFileSync(templatePath, instructionsPath, constants.COPYFILE_EXCL)
    chmodSync(instructionsPath, 0o600)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  return directory
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
  const candidates = [
    resolve(root, '.env.local'),
    resolve(root, '.env'),
    resolve(configDirectory, 'config.env'),
  ]
  const loadedFiles = candidates.filter(path => loadFile(path, env))
  if (!readOnly) {
    mkdirSync(configDirectory, { recursive: true, mode: 0o700 })
  }
  const configPath = readOnly
    ? resolve(configDirectory, 'config.env')
    : ensureUserConfig(configDirectory)
  const userProfilePath = readOnly
    ? resolve(configDirectory, 'USER.md')
    : ensureUserProfile(configDirectory)
  const frontendMemoryPath = resolve(configDirectory, 'frontend-memory.json')
  const frontendNotesPath = resolve(configDirectory, 'frontend-notes.json')
  const taskStatePath = resolve(configDirectory, 'tasks.json')
  const defaultOpenCodeWorkspace = !env.OPENCODE_WORKSPACE
  const openCodeWorkspace = env.OPENCODE_WORKSPACE
    ? resolve(root, env.OPENCODE_WORKSPACE)
    : resolve(configDirectory, 'workspaces/opencode')
  const defaultOpenClawWorkspace = !env.QWEN_AUDIO_AGENT_OPENCLAW_WORKSPACE
  const openClawWorkspace = env.QWEN_AUDIO_AGENT_OPENCLAW_WORKSPACE
    ? resolve(root, env.QWEN_AUDIO_AGENT_OPENCLAW_WORKSPACE)
    : resolve(configDirectory, 'workspaces/openclaw')
  const openClawStateDirectory = env.QWEN_AUDIO_AGENT_OPENCLAW_STATE_DIR
    ? resolve(root, env.QWEN_AUDIO_AGENT_OPENCLAW_STATE_DIR)
    : resolve(configDirectory, 'backends/openclaw/state')
  const defaultQoderWorkspace = !env.QODER_WORKSPACE
  const qoderWorkspace = env.QODER_WORKSPACE
    ? resolve(root, env.QODER_WORKSPACE)
    : resolve(configDirectory, 'workspaces/qoder')
  const defaultKimiWorkspace = !env.KIMI_WORKSPACE
  const kimiWorkspace = env.KIMI_WORKSPACE
    ? resolve(root, env.KIMI_WORKSPACE)
    : resolve(configDirectory, 'workspaces/kimi')
  const defaultHermesWorkspace = !env.HERMES_WORKSPACE
  const hermesWorkspace = env.HERMES_WORKSPACE
    ? resolve(root, env.HERMES_WORKSPACE)
    : resolve(configDirectory, 'workspaces/hermes')
  const defaultCodeBuddyWorkspace = !env.CODEBUDDY_WORKSPACE
  const codeBuddyWorkspace = env.CODEBUDDY_WORKSPACE
    ? resolve(root, env.CODEBUDDY_WORKSPACE)
    : resolve(configDirectory, 'workspaces/codebuddy')
  const defaultCodexWorkspace = !env.CODEX_WORKSPACE
  const codexWorkspace = env.CODEX_WORKSPACE
    ? resolve(root, env.CODEX_WORKSPACE)
    : resolve(configDirectory, 'workspaces/codex')
  const defaultClaudeWorkspace = !env.CLAUDE_WORKSPACE
  const claudeWorkspace = env.CLAUDE_WORKSPACE
    ? resolve(root, env.CLAUDE_WORKSPACE)
    : resolve(configDirectory, 'workspaces/claude')
  const defaultAcpWorkspace = !env.ACP_WORKSPACE
  const acpWorkspace = env.ACP_WORKSPACE
    ? resolve(root, env.ACP_WORKSPACE)
    : resolve(configDirectory, 'workspaces/acp')
  let migratedFiles = []
  if (prepareBackendRuntime && !readOnly) {
    if (defaultOpenCodeWorkspace) {
      ensureManagedWorkspace(
        openCodeWorkspace,
        resolve(root, 'config/opencode/workspace/AGENTS.md'),
      )
    }
    if (defaultOpenClawWorkspace) {
      ensureManagedWorkspace(
        openClawWorkspace,
        resolve(root, 'config/openclaw/workspace/AGENTS.md'),
      )
    }
    if (defaultQoderWorkspace) {
      ensureManagedWorkspace(
        qoderWorkspace,
        resolve(root, 'config/qoder/workspace/AGENTS.md'),
      )
    }
    if (defaultKimiWorkspace) {
      ensureManagedWorkspace(
        kimiWorkspace,
        resolve(root, 'config/kimi/workspace/AGENTS.md'),
      )
    }
    if (defaultHermesWorkspace) {
      ensureManagedWorkspace(
        hermesWorkspace,
        resolve(root, 'config/hermes/workspace/AGENTS.md'),
      )
    }
    if (defaultCodeBuddyWorkspace) {
      ensureManagedWorkspace(
        codeBuddyWorkspace,
        resolve(root, 'config/codebuddy/workspace/AGENTS.md'),
      )
      ensureCodeBuddyTemplate(
        resolve(root, 'config/codebuddy/workspace/.codebuddy/models.json'),
        resolve(codeBuddyWorkspace, '.codebuddy/models.json'),
        env,
      )
    }
    if (defaultCodexWorkspace) {
      ensureManagedWorkspace(
        codexWorkspace,
        resolve(root, 'config/codex/workspace/AGENTS.md'),
      )
    }
    if (defaultClaudeWorkspace) {
      ensureManagedWorkspace(
        claudeWorkspace,
        resolve(root, 'config/claude/workspace/AGENTS.md'),
      )
    }
    if (defaultAcpWorkspace) {
      ensureManagedWorkspace(
        acpWorkspace,
        resolve(root, 'config/acp/workspace/AGENTS.md'),
      )
    }
    mkdirSync(openClawStateDirectory, { recursive: true, mode: 0o700 })
    env.OPENCODE_WORKSPACE = openCodeWorkspace
    env.QWEN_AUDIO_AGENT_OPENCLAW_WORKSPACE = openClawWorkspace
    env.QWEN_AUDIO_AGENT_OPENCLAW_STATE_DIR = openClawStateDirectory
    env.QODER_WORKSPACE = qoderWorkspace
    env.KIMI_WORKSPACE = kimiWorkspace
    env.HERMES_WORKSPACE = hermesWorkspace
    env.CODEBUDDY_WORKSPACE = codeBuddyWorkspace
    env.CODEX_WORKSPACE = codexWorkspace
    env.CLAUDE_WORKSPACE = claudeWorkspace
    env.ACP_WORKSPACE = acpWorkspace
    migratedFiles = [
      [resolve(root, 'runtime/frontend-memory.json'), frontendMemoryPath],
      [resolve(root, 'runtime/tasks.json'), taskStatePath],
    ].filter(([legacyPath, targetPath]) => (
      migratePrivateFile(legacyPath, targetPath)
    )).map(([, targetPath]) => targetPath)
  }
  const secret = generateSecret && !readOnly
    ? ensureGeneratedSecret(env, configDirectory)
    : { generated: false, statePath: null }
  return {
    configDirectory,
    configPath,
    userProfilePath,
    frontendMemoryPath,
    frontendNotesPath,
    taskStatePath,
    openCodeWorkspace,
    openClawWorkspace,
    qoderWorkspace,
    kimiWorkspace,
    hermesWorkspace,
    codeBuddyWorkspace,
    codexWorkspace,
    claudeWorkspace,
    acpWorkspace,
    openClawStateDirectory,
    migratedFiles,
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
