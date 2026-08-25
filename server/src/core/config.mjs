import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import {
  defaultBackendWorkspace,
  loadRuntimeEnvironment,
} from '../../../shared/runtime-environment.mjs'
import {
  backendDefinition,
  backendNames,
  effectiveBackendPermissionMode,
  normalizeBackendProtocol,
  resolveBackendOwnership,
} from '../../../shared/backend-catalog.mjs'
import {
  resolveRealtimeFrontendConfiguration,
} from '../../../shared/realtime-provider-catalog.mjs'
import {
  loadFrontendProfile,
  resolveFrontendProfileConfiguration,
} from './frontend-profile.mjs'

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

export function resolveBackendWorkspace(
  protocol,
  env = process.env,
  configDirectory = runtimeEnvironment.dataDirectory,
) {
  const definition = backendDefinition(protocol)
  if (!definition?.workspaceEnvironment) {
    throw new Error(`后台 ${protocol} 没有 workspace 配置`)
  }
  const configured = env[definition.workspaceEnvironment]
  return configured
    ? resolve(root, configured)
    : defaultBackendWorkspace(configDirectory)
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
    qwen: name,
    kimi: common,
    hermes: common,
    codeBuddy: name,
    codex: name,
    claude: common,
    deepSeekHarness: String(
      env.DEEPSEEK_HARNESS_MODEL
      || (name.startsWith('deepseek-') ? name : ''),
    ).trim(),
    pi: common,
    acp: common,
  }
}

export function resolveWebSearchConfiguration(env = process.env) {
  const bailianMcpUrl = 'https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp'
  const explicitMcpUrl = String(env.QWEN_AUDIO_WEB_SEARCH_MCP_URL || '').trim()
  const dashscopeApiKey = String(env.DASHSCOPE_API_KEY || '').trim()
  const requestedProvider = String(
    env.QWEN_AUDIO_WEB_SEARCH_PROVIDER || '',
  ).trim().toLowerCase()
  const provider = requestedProvider || (explicitMcpUrl ? 'mcp' : 'bing')
  if (!['bailian', 'bing', 'mcp', 'none'].includes(provider)) {
    throw new Error(
      '不支持的 Web Search Provider：'
      + `${provider}（可选 bailian、bing、mcp、none）`,
    )
  }
  const mcpUrl = provider === 'bailian' ? bailianMcpUrl : explicitMcpUrl
  const usesBailianMcp = provider === 'bailian'
  return {
    provider,
    mcpUrl,
    mcpToken: String(
      env.QWEN_AUDIO_WEB_SEARCH_MCP_TOKEN
      || (usesBailianMcp ? dashscopeApiKey : ''),
    ).trim(),
    mcpTool: String(env.QWEN_AUDIO_WEB_SEARCH_MCP_TOOL || '').trim()
      || (usesBailianMcp ? 'bailian_web_search' : 'web_search'),
  }
}

const configuredAgentProtocol = normalizeBackendProtocol(
  process.env.AGENT_PROTOCOL,
)
const configuredBackendDefinition = backendDefinition(configuredAgentProtocol)
if (configuredAgentProtocol && !configuredBackendDefinition) {
  throw new Error(
    `不支持的后台 Agent：${configuredAgentProtocol}`
    + `（可选 ${backendNames().join('、')}）`,
  )
}
const backendOwnership = configuredAgentProtocol
  ? resolveBackendOwnership(configuredAgentProtocol, {
      baseUrlConfigured: Boolean(
        configuredBackendDefinition.baseUrlEnvironment
        && String(
          process.env[configuredBackendDefinition.baseUrlEnvironment] || '',
        ).trim()
      ),
      requestedOwnership: process.env.QWEN_AUDIO_AGENT_BACKEND_OWNERSHIP,
    })
  : 'owned'
const backendModels = resolveBackendModels()
const managedOpenClawBailian = (
  configuredAgentProtocol === 'openclaw'
  && Boolean(backendModels.common)
  && Boolean(process.env.DASHSCOPE_API_KEY)
  && !process.env.OPENCLAW_CONFIG_PATH
)
const requestedBackendPermissionMode = String(
  process.env.QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE || 'native',
).toLowerCase()
if (
  configuredAgentProtocol
  && !['native', 'full'].includes(requestedBackendPermissionMode)
) {
  throw new Error(
    `不支持的后台权限模式：${requestedBackendPermissionMode}（可选 native、full）`,
  )
}
// 无权限审批机制的后台（alwaysFullPermission，如 Pi）无论配置什么都以
// full 运行，这里直接归一化为真实生效的模式，健康状态据此上报。
const backendPermissionMode = effectiveBackendPermissionMode(
  configuredAgentProtocol,
  requestedBackendPermissionMode,
)
const requestedAgentProtocol = configuredAgentProtocol
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
const webSearch = resolveWebSearchConfiguration(process.env)
const loadedFrontendProfile = loadFrontendProfile({
  filePath: process.env.QWEN_AUDIO_FRONTEND_PROFILE,
})
const frontendProfileConfiguration = resolveFrontendProfileConfiguration({
  profile: loadedFrontendProfile,
  env: process.env,
  defaultAssistantProfilePath: runtimeEnvironment.assistantProfilePath,
  baseDirectory: root,
})

export const config = {
  root,
  configDirectory: runtimeEnvironment.configDirectory,
  dataDirectory: runtimeEnvironment.dataDirectory,
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
  webSearchProvider: webSearch.provider,
  webSearchMcpUrl: webSearch.mcpUrl,
  webSearchMcpToken: webSearch.mcpToken,
  webSearchMcpTool: webSearch.mcpTool,
  frontendProfile: frontendProfileConfiguration.frontendProfile,
  frontendMcpConfigPath: frontendProfileConfiguration.frontendMcpConfigPath,
  frontendOpenApiConfigPath: frontendProfileConfiguration.frontendOpenApiConfigPath,
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
      directory: resolveBackendWorkspace('opencode'),
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
        || ''
      ),
      tokenFile: (
        process.env.OPENCLAW_GATEWAY_TOKEN_FILE
        || resolve(runtimeEnvironment.openClawStateDirectory, 'gateway-token')
      ),
      model: backendModels.openClaw,
      directory: resolveBackendWorkspace('openclaw'),
      cliPath: String(process.env.OPENCLAW_ACP_BIN || '').trim(),
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
      directory: resolveBackendWorkspace('qoder'),
      cliPath: String(
        process.env.QODERCLI_PATH || process.env.QODER_CLI_PATH || '',
      ).trim(),
      configDirectory: process.env.QODER_CONFIG_DIR
        ? resolve(process.env.QODER_CONFIG_DIR)
        : '',
    },
    qwen: {
      model: String(backendModels.qwen).trim(),
      directory: resolveBackendWorkspace('qwen'),
      cliPath: String(process.env.QWEN_CODE_BIN || '').trim(),
    },
    kimi: {
      model: String(backendModels.kimi).trim(),
      directory: resolveBackendWorkspace('kimi'),
      cliPath: String(process.env.KIMI_CODE_BIN || '').trim(),
    },
    hermes: {
      model: String(backendModels.hermes).trim(),
      directory: resolveBackendWorkspace('hermes'),
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
      directory: resolveBackendWorkspace('codebuddy'),
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
      directory: resolveBackendWorkspace('codex'),
      cliPath: String(process.env.CODEX_ACP_BIN || '').trim(),
    },
    claude: {
      model: String(backendModels.claude).trim(),
      directory: resolveBackendWorkspace('claude'),
      cliPath: String(process.env.CLAUDE_CODE_ACP_BIN || '').trim(),
      claudeExecutable: String(
        process.env.CLAUDE_CODE_EXECUTABLE || '',
      ).trim(),
      configDirectory: process.env.CLAUDE_CONFIG_DIR
        ? resolve(process.env.CLAUDE_CONFIG_DIR)
        : '',
    },
    deepseek: {
      model: backendModels.deepSeekHarness,
      directory: resolveBackendWorkspace('deepseek'),
      cliPath: String(process.env.DEEPSEEK_HARNESS_ACP_BIN || '').trim(),
      sessionRoot: resolve(
        runtimeEnvironment.configDirectory,
        'backends/deepseek-harness/sessions',
      ),
    },
    pi: {
      model: String(backendModels.pi).trim(),
      directory: resolveBackendWorkspace('pi'),
      cliPath: String(process.env.PI_ACP_BIN || '').trim(),
    },
    acp: {
      model: String(backendModels.acp).trim(),
      directory: resolveBackendWorkspace('acp'),
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
  assistantProfilePath: frontendProfileConfiguration.assistantProfilePath,
  frontendMemoryPath: process.env.QWEN_AUDIO_AGENT_MEMORY_PATH
    ? resolve(root, process.env.QWEN_AUDIO_AGENT_MEMORY_PATH)
    : process.env.QWEN_AUDIO_AGENT_FRONTEND_MEMORY_PATH
      ? resolve(root, process.env.QWEN_AUDIO_AGENT_FRONTEND_MEMORY_PATH)
    : runtimeEnvironment.frontendMemoryPath,
  frontendNotesPath: process.env.QWEN_AUDIO_AGENT_FRONTEND_NOTES_PATH
    ? resolve(root, process.env.QWEN_AUDIO_AGENT_FRONTEND_NOTES_PATH)
    : runtimeEnvironment.frontendNotesPath,
  knowledgeDirectory: process.env.QWEN_AUDIO_AGENT_KNOWLEDGE_DIR
    ? resolve(root, process.env.QWEN_AUDIO_AGENT_KNOWLEDGE_DIR)
    : runtimeEnvironment.knowledgeDirectory,
  userModelPath: process.env.QWEN_AUDIO_AGENT_USER_MODEL_PATH
    ? resolve(root, process.env.QWEN_AUDIO_AGENT_USER_MODEL_PATH)
    : process.env.QWEN_AUDIO_AGENT_USER_PROFILE_PATH
      ? resolve(root, process.env.QWEN_AUDIO_AGENT_USER_PROFILE_PATH)
    : runtimeEnvironment.userModelPath,
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
  // Session-end automatic memory extraction (invisible memory, issue #92).
  // Runs one stateless request against a lightweight OpenAI-compatible text
  // model after a voice session closes; silently disabled without an API key
  // so local speech-to-speech setups degrade without a sound.
  memoryAutoEnabled: String(
    process.env.QWEN_AUDIO_MEMORY_AUTO || 'on',
  ).toLowerCase() !== 'off',
  memoryModel: String(process.env.QWEN_AUDIO_MEMORY_MODEL || '').trim()
    || 'qwen-flash',
  memoryBaseUrl: (
    process.env.QWEN_AUDIO_MEMORY_BASE_URL
    || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
  ).replace(/\/+$/, ''),
  memoryApiKey: process.env.QWEN_AUDIO_MEMORY_API_KEY
    || process.env.DASHSCOPE_API_KEY
    || '',
  memoryAuditPath: resolve(
    runtimeEnvironment.configDirectory,
    'memory-audit.jsonl',
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
  backgroundTaskProgressCheckMs: numberSetting(
    process.env.QWEN_AUDIO_AGENT_BACKGROUND_TASK_PROGRESS_CHECK_MS
      || process.env.QWEN_AUDIO_AGENT_SCHEDULED_TASK_PROGRESS_CHECK_MS,
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
