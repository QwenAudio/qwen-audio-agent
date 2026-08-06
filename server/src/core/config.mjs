import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { loadRuntimeEnvironment } from '../../../shared/runtime-environment.mjs'
import {
  backendDefinition,
  backendNames,
  normalizeBackendProtocol,
} from '../../../shared/backend-catalog.mjs'
import {
  resolveRealtimeFrontendConfiguration,
} from '../../../shared/realtime-provider-catalog.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const sourceRoot = resolve(here, '../../..')
const root = process.env.QWEN_AUDIO_AGENT_RUNTIME_ROOT || sourceRoot
const runtimeEnvironment = loadRuntimeEnvironment({ root })

export function numberSetting(value, fallback, {
  min = Number.NEGATIVE_INFINITY,
  max = Number.POSITIVE_INFINITY,
} = {}) {
  if (value === null || value === undefined) return fallback
  const source = typeof value === 'string' ? value.trim() : value
  if (source === '') return fallback
  const parsed = Number(source)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

export function resolveOpenCodeWorkspace(
  env = process.env,
  configDirectory = runtimeEnvironment.configDirectory,
) {
  return env.OPENCODE_WORKSPACE
    ? resolve(root, env.OPENCODE_WORKSPACE)
    : resolve(configDirectory, 'workspaces/opencode')
}

export function resolveQoderWorkspace(
  env = process.env,
  configDirectory = runtimeEnvironment.configDirectory,
) {
  return env.QODER_WORKSPACE
    ? resolve(root, env.QODER_WORKSPACE)
    : resolve(configDirectory, 'workspaces/qoder')
}

export function resolveKimiWorkspace(
  env = process.env,
  configDirectory = runtimeEnvironment.configDirectory,
) {
  return env.KIMI_WORKSPACE
    ? resolve(root, env.KIMI_WORKSPACE)
    : resolve(configDirectory, 'workspaces/kimi')
}

export function resolveHermesWorkspace(
  env = process.env,
  configDirectory = runtimeEnvironment.configDirectory,
) {
  return env.HERMES_WORKSPACE
    ? resolve(root, env.HERMES_WORKSPACE)
    : resolve(configDirectory, 'workspaces/hermes')
}

export function resolveCodeBuddyWorkspace(
  env = process.env,
  configDirectory = runtimeEnvironment.configDirectory,
) {
  return env.CODEBUDDY_WORKSPACE
    ? resolve(root, env.CODEBUDDY_WORKSPACE)
    : resolve(configDirectory, 'workspaces/codebuddy')
}

export function resolveCodexWorkspace(
  env = process.env,
  configDirectory = runtimeEnvironment.configDirectory,
) {
  return env.CODEX_WORKSPACE
    ? resolve(root, env.CODEX_WORKSPACE)
    : resolve(configDirectory, 'workspaces/codex')
}

export function resolveClaudeWorkspace(
  env = process.env,
  configDirectory = runtimeEnvironment.configDirectory,
) {
  return env.CLAUDE_WORKSPACE
    ? resolve(root, env.CLAUDE_WORKSPACE)
    : resolve(configDirectory, 'workspaces/claude')
}

export function resolveOpenClawWorkspace(
  env = process.env,
  configDirectory = runtimeEnvironment.configDirectory,
) {
  return env.QWEN_AUDIO_AGENT_OPENCLAW_WORKSPACE
    ? resolve(root, env.QWEN_AUDIO_AGENT_OPENCLAW_WORKSPACE)
    : resolve(configDirectory, 'workspaces/openclaw')
}

export function resolveAcpWorkspace(
  env = process.env,
  configDirectory = runtimeEnvironment.configDirectory,
) {
  return env.ACP_WORKSPACE
    ? resolve(root, env.ACP_WORKSPACE)
    : resolve(configDirectory, 'workspaces/acp')
}

export function resolveAcpArgs(value) {
  const source = String(value || '').trim()
  if (!source) return []
  if (source.startsWith('[')) {
    let parsed
    try {
      parsed = JSON.parse(source)
    } catch {
      throw new Error('ACP_ARGS 不是有效的 JSON 数组')
    }
    if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) {
      throw new Error('ACP_ARGS 必须是字符串组成的 JSON 数组')
    }
    return parsed
  }
  return source.split(/\s+/)
}

function backendModelName(value) {
  const model = String(value || '').trim()
  const separator = model.indexOf('/')
  return separator >= 0 ? model.slice(separator + 1) : model
}

export function resolveBackendModels(env = process.env) {
  const configured = String(
    env.QWEN_AUDIO_AGENT_BACKEND_MODEL || '',
  ).trim()
  const common = configured.toLowerCase() === 'auto' ? '' : configured
  const name = backendModelName(common)
  return {
    common,
    openCode: common ? `alibaba-cn/${name}` : '',
    openClaw: common ? `bailian/${name}` : '',
    qoder: name,
    kimi: common,
    hermes: common,
    codeBuddy: name,
    codex: name,
    claude: common,
    acp: common,
  }
}

const configuredAgentProtocol = normalizeBackendProtocol(
  process.env.AGENT_PROTOCOL,
)
const backendOwnership = 'owned'
const backendModels = resolveBackendModels()
const managedOpenClawBailian = (
  configuredAgentProtocol === 'openclaw'
  && Boolean(backendModels.common)
  && Boolean(process.env.DASHSCOPE_API_KEY)
  && !process.env.OPENCLAW_CONFIG_PATH
)
const backendPermissionMode = String(
  process.env.QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE || 'native',
).toLowerCase()
if (
  configuredAgentProtocol
  && !['native', 'full'].includes(backendPermissionMode)
) {
  throw new Error(
    `不支持的后台权限模式：${backendPermissionMode}（可选 native、full）`,
  )
}
const requestedAgentProtocol = configuredAgentProtocol
if (requestedAgentProtocol && !backendDefinition(requestedAgentProtocol)) {
  throw new Error(
    `不支持的后台 Agent：${requestedAgentProtocol}`
    + `（可选 ${backendNames().join('、')}）`,
  )
}
const sharedBackendAgent = String(
  process.env.QWEN_AUDIO_AGENT_BACKEND_AGENT || '',
).trim()
function legacyBackendAgent(value, legacyDefault) {
  const selected = String(value || '').trim()
  return selected === legacyDefault ? 'qwen-audio-agent-backend' : selected
}

export function resolveOpenCodeCoordinatorAgent(env = process.env) {
  const selected = String(
    env.QWEN_AUDIO_AGENT_BACKEND_AGENT
    || env.OPENCODE_COORDINATOR_AGENT
    || '',
  ).trim()
  return [
    'qwen-audio-agent-backend',
    'qwen-audio-agent-coordinator',
  ].includes(selected) ? '' : selected
}

const realtimeFrontend = resolveRealtimeFrontendConfiguration(process.env)

export const config = {
  root,
  host: process.env.HOST || '127.0.0.1',
  // PORT=0 lets an embedded host (e.g. the desktop app) fall back to a
  // random loopback port and learn it from the child process report.
  port: String(process.env.PORT || '').trim() === '0'
    ? 0
    : numberSetting(process.env.PORT, 3101, { min: 1, max: 65535 }),
  audioProvider: realtimeFrontend.provider,
  realtimeConfigSignature: realtimeFrontend.signature,
  dashscopeApiKey: realtimeFrontend.dashscopeApiKey,
  audioRealtimeBaseUrl: realtimeFrontend.dashscopeRealtimeUrl,
  // User-managed huggingface/speech-to-speech OpenAI Realtime endpoint. The
  // pipeline owns its STT, LLM, TTS and voice configuration; Gateway only
  // connects to the endpoint and supplies the shared frontend instructions and
  // tools for each realtime Session.
  speechToSpeechRealtimeUrl: realtimeFrontend.speechToSpeechRealtimeUrl,
  // Do not advertise a local service merely because a default endpoint
  // exists. It becomes selectable when the user explicitly configures it or
  // chooses it as the active frontend.
  speechToSpeechConfigured: realtimeFrontend.speechToSpeechConfigured,
  // The upstream WebSocket does not require authentication. This optional
  // credential is useful only when users put it behind an authenticated proxy.
  speechToSpeechAuthToken: realtimeFrontend.speechToSpeechAuthToken,
  audioModel: realtimeFrontend.dashscopeModel,
  audioVoice: realtimeFrontend.dashscopeVoice,
  allowedOrigins: String(process.env.QWEN_AUDIO_AGENT_ALLOWED_ORIGINS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean),
  authSecret: process.env.QWEN_AUDIO_AGENT_AUTH_SECRET || '',
  identityMode: (
    process.env.QWEN_AUDIO_AGENT_IDENTITY_MODE || 'personal'
  ).toLowerCase() === 'browser' ? 'browser' : 'personal',
  personalOwnerId: process.env.QWEN_AUDIO_AGENT_PERSONAL_OWNER_ID || 'user_personal',
  agentProtocol: requestedAgentProtocol,
  backendOwnership,
  backendPermissionMode,
  agentTimeoutMs: numberSetting(process.env.AGENT_TIMEOUT_MS, 300000, { min: 10000 }),
  // Per-backend option namespaces keyed by driver id. AgentClient merges the
  // selected namespace with optional overrides, so adding a backend only
  // requires appending one entry here.
  backends: {
    opencode: {
      baseUrl: (
        process.env.OPENCODE_BASE_URL
        || 'http://127.0.0.1:4096'
      ).replace(/\/+$/, ''),
      model: backendModels.openCode,
      directory: resolveOpenCodeWorkspace(),
      coordinatorAgent: resolveOpenCodeCoordinatorAgent(),
    },
    openclaw: {
      baseUrl: (
        process.env.OPENCLAW_BASE_URL
        || 'http://127.0.0.1:18789'
      ).replace(/\/+$/, ''),
      token: (
        process.env.OPENCLAW_GATEWAY_TOKEN
        || process.env.AGENT_API_KEY
        || (managedOpenClawBailian
          ? process.env.QWEN_AUDIO_AGENT_AUTH_SECRET
          : '')
        || ''
      ),
      tokenFile: (
        process.env.OPENCLAW_GATEWAY_TOKEN_FILE
        || resolve(runtimeEnvironment.openClawStateDirectory, 'gateway-token')
      ),
      model: backendModels.openClaw,
      directory: resolveOpenClawWorkspace(),
      coordinatorAgent: (
        sharedBackendAgent
        || legacyBackendAgent(
          process.env.OPENCLAW_COORDINATOR_AGENT,
          'voice-coordinator',
        )
        || (managedOpenClawBailian ? 'qwen-audio-agent-backend' : '')
      ),
    },
    qoder: {
      model: String(backendModels.qoder).trim(),
      directory: resolveQoderWorkspace(),
      cliPath: String(
        process.env.QODERCLI_PATH || process.env.QODER_CLI_PATH || '',
      ).trim(),
      configDirectory: process.env.QODER_CONFIG_DIR
        ? resolve(process.env.QODER_CONFIG_DIR)
        : '',
    },
    kimi: {
      model: String(backendModels.kimi).trim(),
      directory: resolveKimiWorkspace(),
      cliPath: String(process.env.KIMI_CODE_BIN || '').trim(),
    },
    hermes: {
      model: String(backendModels.hermes).trim(),
      directory: resolveHermesWorkspace(),
      cliPath: String(process.env.HERMES_BIN || '').trim(),
    },
    codebuddy: {
      model: String(backendModels.codeBuddy).trim(),
      modelUrl: (
        process.env.CODEBUDDY_MODEL_URL
        || (backendModels.common ? (
          process.env.DASHSCOPE_WORKSPACE_ID
            ? `https://${process.env.DASHSCOPE_WORKSPACE_ID}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions`
            : 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
        ) : '')
      ),
      directory: resolveCodeBuddyWorkspace(),
      cliPath: String(process.env.CODEBUDDY_BIN || '').trim(),
    },
    codex: {
      model: String(backendModels.codex).trim(),
      modelUrl: (
        process.env.CODEX_BASE_URL
        || (backendModels.common ? (
          process.env.DASHSCOPE_WORKSPACE_ID
            ? `https://${process.env.DASHSCOPE_WORKSPACE_ID}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`
            : 'https://dashscope.aliyuncs.com/compatible-mode/v1'
        ) : '')
      ).replace(/\/+$/, ''),
      directory: resolveCodexWorkspace(),
      cliPath: String(process.env.CODEX_ACP_BIN || '').trim(),
    },
    claude: {
      model: String(backendModels.claude).trim(),
      directory: resolveClaudeWorkspace(),
      cliPath: String(process.env.CLAUDE_CODE_ACP_BIN || '').trim(),
      claudeExecutable: String(
        process.env.CLAUDE_CODE_EXECUTABLE || '',
      ).trim(),
      configDirectory: process.env.CLAUDE_CONFIG_DIR
        ? resolve(process.env.CLAUDE_CONFIG_DIR)
        : '',
    },
    acp: {
      model: String(backendModels.acp).trim(),
      directory: resolveAcpWorkspace(),
      cliPath: String(process.env.ACP_COMMAND || '').trim(),
      args: resolveAcpArgs(process.env.ACP_ARGS),
      label: String(process.env.ACP_LABEL || 'ACP Agent').trim() || 'ACP Agent',
      coordinatorAgent: String(process.env.ACP_COORDINATOR_AGENT || '').trim(),
    },
  },
  announceIntoContext: (
    String(process.env.QWEN_AUDIO_AGENT_ANNOUNCE_INTO_CONTEXT || 'true').toLowerCase()
    === 'true'
  ),
  resultContextMaxChars: numberSetting(
    process.env.QWEN_AUDIO_AGENT_RESULT_CONTEXT_MAX_CHARS,
    6000,
    { min: 256 },
  ),
  announcementBatchMs: numberSetting(
    process.env.QWEN_AUDIO_AGENT_ANNOUNCEMENT_BATCH_MS,
    120,
    { min: 0, max: 1000 },
  ),
  announcementMaxBatchItems: numberSetting(
    process.env.QWEN_AUDIO_AGENT_ANNOUNCEMENT_MAX_BATCH_ITEMS,
    8,
    { min: 1, max: 32 },
  ),
  announcementQuietMs: numberSetting(
    process.env.QWEN_AUDIO_AGENT_ANNOUNCEMENT_QUIET_MS,
    350,
    { min: 0, max: 2000 },
  ),
  announcementAcknowledgementTimeoutMs: numberSetting(
    process.env.QWEN_AUDIO_AGENT_ANNOUNCEMENT_ACK_TIMEOUT_MS,
    120_000,
    { min: 10_000 },
  ),
  announcementMaxRetryAttempts: numberSetting(
    process.env.QWEN_AUDIO_AGENT_ANNOUNCEMENT_MAX_RETRIES,
    8,
    { min: 1, max: 32 },
  ),
  frontendPromptDir: process.env.QWEN_AUDIO_AGENT_FRONTEND_PROMPT_DIR
    ? resolve(root, process.env.QWEN_AUDIO_AGENT_FRONTEND_PROMPT_DIR)
    : resolve(root, 'config/frontend-agent'),
  frontendMemoryPath: process.env.QWEN_AUDIO_AGENT_FRONTEND_MEMORY_PATH
    ? resolve(root, process.env.QWEN_AUDIO_AGENT_FRONTEND_MEMORY_PATH)
    : runtimeEnvironment.frontendMemoryPath,
  frontendNotesPath: process.env.QWEN_AUDIO_AGENT_FRONTEND_NOTES_PATH
    ? resolve(root, process.env.QWEN_AUDIO_AGENT_FRONTEND_NOTES_PATH)
    : runtimeEnvironment.frontendNotesPath,
  userProfilePath: process.env.QWEN_AUDIO_AGENT_USER_PROFILE_PATH
    ? resolve(root, process.env.QWEN_AUDIO_AGENT_USER_PROFILE_PATH)
    : runtimeEnvironment.userProfilePath,
  taskStatePath: process.env.QWEN_AUDIO_AGENT_TASK_STATE_PATH
    ? resolve(root, process.env.QWEN_AUDIO_AGENT_TASK_STATE_PATH)
    : runtimeEnvironment.taskStatePath,
  backendSessionStatePath: process.env.QWEN_AUDIO_AGENT_BACKEND_SESSION_STATE_PATH
    ? resolve(root, process.env.QWEN_AUDIO_AGENT_BACKEND_SESSION_STATE_PATH)
    : resolve(runtimeEnvironment.configDirectory, 'state/acp-sessions.json'),
  taskTerminalTtlMs: numberSetting(
    process.env.QWEN_AUDIO_AGENT_TASK_TERMINAL_TTL_MS,
    86_400_000,
    { min: 60_000 },
  ),
  taskPendingNotificationTtlMs: numberSetting(
    process.env.QWEN_AUDIO_AGENT_TASK_NOTIFICATION_TTL_MS,
    604_800_000,
    { min: 60_000 },
  ),
  taskNotificationClaimTtlMs: numberSetting(
    process.env.QWEN_AUDIO_AGENT_TASK_NOTIFICATION_CLAIM_TTL_MS,
    60_000,
    { min: 5_000 },
  ),
  maxTerminalTasksPerOwner: numberSetting(
    process.env.QWEN_AUDIO_AGENT_MAX_TERMINAL_TASKS_PER_OWNER,
    100,
    { min: 10 },
  ),
  taskMaxConcurrent: numberSetting(
    process.env.QWEN_AUDIO_AGENT_TASK_MAX_CONCURRENT,
    4,
    { min: 1, max: 64 },
  ),
  taskMaxConcurrentPerOwner: numberSetting(
    process.env.QWEN_AUDIO_AGENT_TASK_MAX_CONCURRENT_PER_OWNER,
    2,
    { min: 1, max: 16 },
  ),
  conversationSessionTtlMs: numberSetting(
    process.env.QWEN_AUDIO_AGENT_SESSION_TTL_MS,
    21_600_000,
    { min: 60_000 },
  ),
  maxConversationSessions: numberSetting(
    process.env.QWEN_AUDIO_AGENT_MAX_SESSIONS,
    500,
    { min: 10 },
  ),
  // Zero keeps explicit personal memories until the user removes them.
  frontendMemoryOwnerTtlMs: numberSetting(
    process.env.QWEN_AUDIO_AGENT_MEMORY_OWNER_TTL_MS,
    0,
    { min: 0 },
  ),
  maxFrontendMemoryOwners: numberSetting(
    process.env.QWEN_AUDIO_AGENT_MAX_MEMORY_OWNERS,
    1000,
    { min: 10 },
  ),
  reminderSchedulerEnabled: String(
    process.env.QWEN_AUDIO_AGENT_REMINDER_SCHEDULER || 'true'
  ).toLowerCase() === 'true',
  reminderMaxPerOwner: numberSetting(
    process.env.QWEN_AUDIO_AGENT_REMINDER_MAX_PER_OWNER,
    50,
    { min: 1, max: 500 },
  ),
  scheduledTaskTimeoutMs: numberSetting(
    process.env.QWEN_AUDIO_AGENT_SCHEDULED_TASK_TIMEOUT_MS,
    1_800_000,
    { min: 60_000 },
  ),
  scheduledTaskProgressCheckMs: numberSetting(
    process.env.QWEN_AUDIO_AGENT_SCHEDULED_TASK_PROGRESS_CHECK_MS,
    300_000,
    { min: 30_000 },
  ),
  offlineNotificationDelayMs: numberSetting(
    process.env.QWEN_AUDIO_AGENT_OFFLINE_NOTIFICATION_DELAY_MS,
    5_000,
    { min: 1_000, max: 120_000 },
  ),
  reminderStaggerMs: numberSetting(
    process.env.QWEN_AUDIO_AGENT_REMINDER_STAGGER_MS,
    30_000,
    { min: 0, max: 300_000 },
  ),
  // The sleep timeout mirrors the desktop auto-hide timeout: the orb hides
  // and the gateway enters sleep mode at the same threshold. The legacy
  // QWEN_AUDIO_SLEEP_TIMEOUT_SECONDS is ignored to avoid divergence.
  sleepTimeoutMs: numberSetting(
    process.env.QWEN_AUDIO_DESKTOP_AUTO_HIDE_SECONDS,
    0,
    { min: 0, max: 86_400 },
  ) * 1000,
  wakeWordEnabled: String(
    process.env.QWEN_AUDIO_WAKE_WORD_ENABLED || '',
  ).toLowerCase() === 'true',
  wakeWord: '你好千问',
  wakeWordModelDirectory: process.env.QWEN_AUDIO_WAKE_WORD_MODEL_DIR
    ? resolve(process.env.QWEN_AUDIO_WAKE_WORD_MODEL_DIR)
    : resolve(runtimeEnvironment.configDirectory, 'models/wake-word'),
}

export function realtimeUrl(baseUrl, model) {
  const separator = baseUrl.includes('?') ? '&' : '?'
  return `${baseUrl}${separator}model=${encodeURIComponent(model)}`
}
