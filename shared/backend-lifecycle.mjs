import { backendDefinition } from './backend-catalog.mjs'

const HERMES_INSTALL_COMMAND = 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash'

// 后台 Agent 接入生命周期的单一事实源。CLI 与桌面端共享这些能力定义；
// 两端只负责选择不同的交互方式，不各自维护安装、配置或认证规则。
const LIFECYCLE_SPECS = {
  opencode: {
    installation: { steps: [{ kind: 'npm', package: 'opencode-ai@1.18.5', packageEnv: 'OPENCODE_PACKAGE' }] },
    configuration: { mode: 'bailian-or-backend-owned' },
    authentication: { command: 'opencode auth login', hint: '首次使用请完成 OpenCode 官方认证；配置百炼 API Key 与后台模型时可直接使用自动配置。' },
  },
  openclaw: {
    installation: { steps: [{ kind: 'npm', package: 'openclaw@2026.6.33', packageEnv: 'OPENCLAW_PACKAGE' }] },
    configuration: { mode: 'bailian-or-backend-owned' },
    authentication: { command: 'openclaw onboard', hint: '首次使用请完成 OpenClaw 官方初始化与认证。' },
  },
  qoder: {
    installation: { steps: [{ kind: 'npm', package: '@qoder-ai/qodercli@1.1.13', packageEnv: 'QODERCLI_PACKAGE' }] },
    configuration: { mode: 'backend-owned' },
    authentication: { command: 'qodercli login', hint: '首次使用请完成 Qoder 官方认证。' },
  },
  kimi: {
    installation: { steps: [{ kind: 'npm', package: '@moonshot-ai/kimi-code@0.32.0', packageEnv: 'KIMI_CODE_PACKAGE' }] },
    configuration: { mode: 'backend-owned' },
    authentication: { command: 'kimi login', hint: '首次使用请完成 Kimi Code 官方认证，或配置官方 KIMI_MODEL_* 模型变量。' },
  },
  hermes: {
    installation: {
      steps: [
        { kind: 'script', command: HERMES_INSTALL_COMMAND, platforms: ['darwin', 'linux'] },
        { kind: 'script', command: 'iex (irm https://hermes-agent.nousresearch.com/install.ps1)', platforms: ['win32'] },
      ],
    },
    configuration: { mode: 'backend-owned' },
    authentication: { command: 'hermes setup --portal', hint: '首次使用请完成 Hermes 官方认证。' },
  },
  codebuddy: {
    installation: { steps: [{ kind: 'npm', package: '@tencent-ai/codebuddy-code@2.132.0', packageEnv: 'CODEBUDDY_PACKAGE' }] },
    configuration: { mode: 'backend-owned' },
    authentication: { command: 'codebuddy', hint: '首次使用请启动 CodeBuddy，并通过 /login 完成登录。' },
  },
  codex: {
    installation: {
      steps: [
        { kind: 'npm', package: '@openai/codex@0.146.0', packageEnv: 'CODEX_PACKAGE' },
        { kind: 'npm', label: 'ACP 适配器', component: 'adapter', package: '@agentclientprotocol/codex-acp@1.1.7', packageEnv: 'CODEX_ACP_PACKAGE' },
      ],
    },
    configuration: { mode: 'backend-owned' },
    authentication: { command: 'codex login', hint: '首次使用请完成 Codex 官方认证。' },
  },
  claude: {
    installation: {
      steps: [
        { kind: 'npm', package: '@anthropic-ai/claude-code@2.1.221', packageEnv: 'CLAUDE_CODE_PACKAGE' },
        { kind: 'npm', label: 'ACP 适配器', component: 'adapter', package: '@zed-industries/claude-code-acp@0.16.2', packageEnv: 'CLAUDE_CODE_ACP_PACKAGE' },
      ],
    },
    configuration: { mode: 'backend-owned' },
    authentication: { command: 'claude', hint: '首次使用请完成 Claude Code 官方认证。' },
  },
  // 通用 ACP 后台由用户提供命令，不属于桌面端的一键接入目录。
  acp: {
    installation: null,
    configuration: { mode: 'user-managed' },
    authentication: null,
  },
}

export function backendLifecycleSpec(id) {
  const definition = backendDefinition(id)
  return definition ? LIFECYCLE_SPECS[definition.id] || null : null
}

export function backendConfigurationSupport(id) {
  return backendLifecycleSpec(id)?.configuration || { mode: 'user-managed' }
}

function clean(value) {
  return String(value || '').trim()
}

function usesAutomaticBailianConfiguration(id, env) {
  const model = clean(env.QWEN_AUDIO_AGENT_BACKEND_MODEL).toLowerCase()
  return (
    ['opencode', 'openclaw'].includes(id)
    && Boolean(clean(env.DASHSCOPE_API_KEY))
    && Boolean(model)
    && model !== 'auto'
  )
}

// 认证由后台 Agent 自己完成。这里仅描述是否存在可信的官方入口；
// OpenCode/OpenClaw 使用项目自动百炼配置时不再要求额外登录。
export function backendAuthenticationSupport(id, {
  env = process.env,
  platform = process.platform,
} = {}) {
  const definition = backendDefinition(id)
  const spec = definition ? backendLifecycleSpec(definition.id) : null
  const command = clean(spec?.authentication?.command)
  if (!command || usesAutomaticBailianConfiguration(definition?.id, env)) {
    return { required: false, supported: false }
  }
  return {
    required: true,
    supported: ['darwin', 'linux', 'win32'].includes(platform),
    command,
  }
}

export function resolveBackendLifecycle(item, {
  installation,
  configuration,
  authentication,
} = {}) {
  const installed = item?.ready === true
  let state = 'not-installed'
  if (installed && authentication?.required === true) {
    state = 'authentication-required'
  } else if (installed) {
    state = 'installed'
  }
  return {
    state,
    installation: {
      ...installation,
      status: installed ? 'installed' : 'not-installed',
    },
    configuration,
    authentication,
    // “已就绪”是运行时事实，不能由安装或认证状态推断。
    readiness: { status: 'not-connected' },
  }
}
