const HERMES_INSTALL_COMMAND = 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash'

// Static backend metadata lives here so CLI, desktop, runtime setup and the
// Gateway do not maintain parallel lists. Executable behavior stays in backend
// drivers; this catalog describes identity, storage and onboarding only.
const definitions = new Map([
  ['opencode', {
    id: 'opencode',
    label: 'OpenCode',
    workspaceEnvironment: 'OPENCODE_WORKSPACE',
    skills: { installer: 'opencode' },
    setup: {
      command: 'opencode',
      executableEnvironment: 'OPENCODE_BIN',
      integration: 'native',
      minimumVersion: '1.18.0',
    },
    lifecycle: {
      installation: { steps: [{ kind: 'npm', package: 'opencode-ai@1.18.5', packageEnv: 'OPENCODE_PACKAGE' }] },
      configuration: { mode: 'bailian-or-backend-owned' },
    },
    onboarding: {
      command: 'opencode auth login',
      hint: '首次使用请完成 OpenCode 官方认证；配置百炼 API Key 与后台模型时可直接使用自动配置。',
      probe: { kind: 'command', args: ['auth', 'list'], parser: 'credential-count' },
    },
    baseUrlEnvironment: 'OPENCODE_BASE_URL',
    defaultBaseUrl: 'http://127.0.0.1:4096',
    supportsFullPermission: true,
    environment: {
      names: [
        'DASHSCOPE_API_KEY',
        'QWEN_AUDIO_AGENT_OPENCODE_ISOLATE_USER_CONFIG',
        'QWEN_AUDIO_AGENT_OPENCODE_XDG_CONFIG_HOME',
      ],
      prefixes: ['OPENCODE_'],
    },
  }],
  ['openclaw', {
    id: 'openclaw',
    label: 'OpenClaw',
    workspaceEnvironment: 'QWEN_AUDIO_AGENT_OPENCLAW_WORKSPACE',
    skills: { installer: 'openclaw' },
    setup: {
      command: 'openclaw',
      executableEnvironment: 'OPENCLAW_BIN',
      integration: 'bridge',
    },
    lifecycle: {
      installation: { steps: [{ kind: 'npm', package: 'openclaw@2026.6.33', packageEnv: 'OPENCLAW_PACKAGE' }] },
      configuration: { mode: 'bailian-or-backend-owned' },
    },
    onboarding: {
      command: 'openclaw onboard',
      hint: '首次使用请完成 OpenClaw 官方初始化与认证。',
      probe: { kind: 'openclaw-state' },
    },
    baseUrlEnvironment: 'OPENCLAW_BASE_URL',
    defaultBaseUrl: 'http://127.0.0.1:18789',
    supportsExternalService: true,
    externalService: {
      credentialEnvironment: 'OPENCLAW_GATEWAY_TOKEN',
    },
    supportsFullPermission: false,
    environment: {
      names: [
        'DASHSCOPE_API_KEY',
        'AGENT_API_KEY',
        'QWAUDIO_CONFIG_DIR',
        'QWEN_AUDIO_AGENT_OPENCLAW_MODEL',
        'QWEN_AUDIO_AGENT_OPENCLAW_MODEL_ID',
        'QWEN_AUDIO_AGENT_OPENCLAW_STATE_DIR',
        'QWEN_AUDIO_AGENT_OPENCLAW_WORKSPACE',
      ],
      prefixes: ['OPENCLAW_'],
    },
  }],
  ['qoder', {
    id: 'qoder',
    label: 'Qoder',
    workspaceEnvironment: 'QODER_WORKSPACE',
    skills: { installer: 'qoder' },
    setup: {
      command: 'qodercli',
      executableEnvironment: ['QODERCLI_PATH', 'QODER_CLI_PATH'],
      integration: 'native',
    },
    lifecycle: {
      installation: { steps: [{ kind: 'npm', package: '@qoder-ai/qodercli@1.1.13', packageEnv: 'QODERCLI_PACKAGE' }] },
      configuration: { mode: 'backend-owned' },
    },
    onboarding: {
      command: 'qodercli login',
      hint: '首次使用请完成 Qoder 官方认证。',
      probe: { kind: 'command', args: ['status'], parser: 'qoder-status' },
    },
    supportsFullPermission: true,
    environment: { prefixes: ['QODER_', 'QODERCLI_'] },
  }],
  ['qwen', {
    id: 'qwen',
    label: 'Qwen Code',
    workspaceEnvironment: 'QWEN_CODE_WORKSPACE',
    skills: { installer: 'qwen-code' },
    setup: {
      command: 'qwen',
      executableEnvironment: 'QWEN_CODE_BIN',
      integration: 'native',
      minimumVersion: '0.21.6',
    },
    lifecycle: {
      installation: { steps: [{ kind: 'npm', package: '@qwen-code/qwen-code@0.21.6', packageEnv: 'QWEN_CODE_PACKAGE' }] },
      configuration: { mode: 'backend-owned' },
    },
    onboarding: {
      command: 'qwen',
      hint: '首次使用请启动 Qwen Code，并通过 /auth 完成认证。',
      probe: { kind: 'qwen-settings' },
    },
    supportsFullPermission: true,
    environment: {
      names: ['DASHSCOPE_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL'],
      prefixes: ['QWEN_CODE_'],
    },
  }],
  ['kimi', {
    id: 'kimi',
    label: 'Kimi Code',
    workspaceEnvironment: 'KIMI_WORKSPACE',
    // kimi 读开放标准通用目录 ~/.agents/skills（skills.sh 同名映射）。
    skills: { installer: 'kimi-code-cli' },
    setup: {
      command: 'kimi',
      executableEnvironment: 'KIMI_CODE_BIN',
      integration: 'native',
      minimumVersion: '0.31.0',
    },
    lifecycle: {
      installation: { steps: [{ kind: 'npm', package: '@moonshot-ai/kimi-code@0.32.0', packageEnv: 'KIMI_CODE_PACKAGE' }] },
      configuration: { mode: 'backend-owned' },
    },
    onboarding: {
      command: 'kimi login',
      hint: '首次使用请完成 Kimi Code 官方认证，或配置官方 KIMI_MODEL_* 模型变量。',
    },
    supportsFullPermission: true,
    environment: { prefixes: ['KIMI_'] },
  }],
  ['hermes', {
    id: 'hermes',
    label: 'Hermes',
    workspaceEnvironment: 'HERMES_WORKSPACE',
    // Hermes 官方唯一技能目录在用户主目录，无项目级约定。
    skills: { installer: 'hermes-agent' },
    setup: {
      command: 'hermes',
      executableEnvironment: 'HERMES_BIN',
      integration: 'native',
    },
    lifecycle: {
      installation: {
        steps: [
          { kind: 'script', command: HERMES_INSTALL_COMMAND, platforms: ['darwin', 'linux'] },
          { kind: 'script', command: 'iex (irm https://hermes-agent.nousresearch.com/install.ps1)', platforms: ['win32'] },
        ],
      },
      configuration: { mode: 'backend-owned' },
    },
    onboarding: {
      command: 'hermes setup --portal',
      hint: '首次使用请完成 Hermes 官方认证。',
    },
    supportsFullPermission: true,
    environment: { prefixes: ['HERMES_'] },
  }],
  ['codebuddy', {
    id: 'codebuddy',
    label: 'CodeBuddy',
    workspaceEnvironment: 'CODEBUDDY_WORKSPACE',
    skills: { installer: 'codebuddy' },
    setup: {
      command: 'codebuddy',
      executableEnvironment: 'CODEBUDDY_BIN',
      integration: 'native',
    },
    lifecycle: {
      installation: { steps: [{ kind: 'npm', package: '@tencent-ai/codebuddy-code@2.132.0', packageEnv: 'CODEBUDDY_PACKAGE' }] },
      configuration: { mode: 'backend-owned' },
    },
    onboarding: {
      command: 'codebuddy',
      hint: '首次使用请启动 CodeBuddy，并通过 /login 完成登录。',
      probe: { kind: 'codebuddy-credentials' },
    },
    supportsFullPermission: true,
    environment: { prefixes: ['CODEBUDDY_'] },
  }],
  ['codex', {
    id: 'codex',
    label: 'Codex',
    workspaceEnvironment: 'CODEX_WORKSPACE',
    skills: { installer: 'codex' },
    setup: {
      command: 'codex',
      executableEnvironment: 'CODEX_PATH',
      integration: 'adapter',
      adapterCommand: 'codex-acp',
      adapterEnvironment: 'CODEX_ACP_BIN',
      adapterRuntimeEnvironment: 'CODEX_ACP_RUNTIME',
    },
    lifecycle: {
      installation: {
        steps: [
          { kind: 'npm', package: '@openai/codex@0.146.0', packageEnv: 'CODEX_PACKAGE' },
          { kind: 'npm', label: 'ACP 适配器', component: 'adapter', package: '@agentclientprotocol/codex-acp@1.1.7', packageEnv: 'CODEX_ACP_PACKAGE' },
        ],
      },
      configuration: { mode: 'backend-owned' },
    },
    onboarding: {
      command: 'codex login',
      hint: '首次使用请完成 Codex 官方认证。',
      probe: { kind: 'command', args: ['login', 'status'], parser: 'codex-status' },
    },
    supportsFullPermission: true,
    environment: {
      names: ['DASHSCOPE_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL'],
      prefixes: ['CODEX_'],
    },
  }],
  ['claude', {
    id: 'claude',
    label: 'Claude Code',
    workspaceEnvironment: 'CLAUDE_WORKSPACE',
    skills: { installer: 'claude-code' },
    setup: {
      command: 'claude',
      executableEnvironment: 'CLAUDE_CODE_EXECUTABLE',
      integration: 'adapter',
      adapterCommand: 'claude-code-acp',
      adapterEnvironment: 'CLAUDE_CODE_ACP_BIN',
      adapterRuntimeEnvironment: 'CLAUDE_CODE_ACP_RUNTIME',
    },
    lifecycle: {
      installation: {
        steps: [
          { kind: 'npm', package: '@anthropic-ai/claude-code@2.1.221', packageEnv: 'CLAUDE_CODE_PACKAGE' },
          { kind: 'npm', label: 'ACP 适配器', component: 'adapter', package: '@zed-industries/claude-code-acp@0.16.2', packageEnv: 'CLAUDE_CODE_ACP_PACKAGE' },
        ],
      },
      configuration: { mode: 'backend-owned' },
    },
    onboarding: {
      command: 'claude',
      hint: '首次使用请完成 Claude Code 官方认证。',
    },
    supportsFullPermission: true,
    environment: {
      names: ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_API_KEY'],
      prefixes: ['CLAUDE_'],
    },
  }],
  ['deepseek', {
    id: 'deepseek',
    label: 'DeepSeek',
    workspaceEnvironment: 'DEEPSEEK_HARNESS_WORKSPACE',
    // skills.sh 暂无 dsh 专属安装器，将来支持后改为对应 installer 即可；
    // 当前 dsh 读开放标准目录 ~/.agents/skills，已可被动受益。
    skills: { installer: null },
    setup: {
      command: 'dsh',
      executableEnvironment: 'DEEPSEEK_HARNESS_BIN',
      integration: 'native',
      adapterCommand: 'dsh-acp-demo',
      adapterEnvironment: 'DEEPSEEK_HARNESS_ACP_BIN',
      adapterRuntimeEnvironment: 'DEEPSEEK_HARNESS_ACP_RUNTIME',
      managedAdapterFallback: false,
      inspectAdapterIndependently: true,
    },
    lifecycle: {
      installation: {
        verifyInstalledPackages: true,
        // Keep the ACP executable package last. If an earlier Developer
        // Preview component fails, setup remains visibly incomplete and a
        // retry fills the whole composition instead of skipping it.
        steps: [
          {
            kind: 'npm',
            label: 'DeepSeek CLI',
            component: 'backend',
            package: '@deepseek-ai/dsh@0.1.0-rc.6',
            registry: 'https://registry.npmjs.org/',
          },
          ...[
          '@deepseek-ai/dsh-llm-deepseek@0.1.0-rc.6',
          '@deepseek-ai/dsh-sandbox-local@0.1.0-rc.6',
          '@deepseek-ai/dsh-subprocess-local@0.1.0-rc.6',
          '@deepseek-ai/dsh-bash-sandbox@0.1.0-rc.6',
          '@deepseek-ai/dsh-token-meter@0.1.0-rc.6',
          '@deepseek-ai/dsh-compaction-basic@0.1.0-rc.6',
          '@deepseek-ai/dsh-fs-sandbox@0.1.0-rc.6',
          '@deepseek-ai/dsh-fs-observation-policy@0.1.0-rc.6',
          '@deepseek-ai/dsh-tool-fs@0.1.0-rc.6',
          '@deepseek-ai/dsh-acp-demo@0.1.0-rc.6',
          ].map((packageName, index, packages) => ({
          kind: 'npm',
          label: index === packages.length - 1 ? 'ACP Runtime' : '运行组件',
          component: 'adapter',
          package: packageName,
          registry: 'https://registry.npmjs.org/',
          })),
        ],
      },
      configuration: { mode: 'backend-owned' },
    },
    onboarding: {
      command: 'dsh web',
      hint: '请在 DeepSeek Web 的“设置 → Models”中为 deepseek-official 填写并保存 DEEPSEEK_API_KEY；仅打开 Web 不代表配置完成。',
      probe: { kind: 'deepseek-credentials' },
    },
    supportsFullPermission: true,
    environment: {
      names: ['DEEPSEEK_API_KEY'],
      prefixes: ['DEEPSEEK_', 'DSH_'],
    },
  }],
  ['pi', {
    id: 'pi',
    label: 'Pi',
    workspaceEnvironment: 'PI_WORKSPACE',
    skills: { installer: 'pi' },
    setup: {
      command: 'pi',
      executableEnvironment: 'PI_BIN',
      integration: 'adapter',
      adapterCommand: 'pi-acp',
      adapterEnvironment: 'PI_ACP_BIN',
      adapterRuntimeEnvironment: 'PI_ACP_RUNTIME',
      minimumVersion: '0.80.4',
    },
    lifecycle: {
      installation: {
        steps: [
          { kind: 'npm', package: '@earendil-works/pi-coding-agent@0.84.1', packageEnv: 'PI_PACKAGE' },
          { kind: 'npm', label: 'ACP 适配器', component: 'adapter', package: 'pi-acp@0.0.33', packageEnv: 'PI_ACP_PACKAGE' },
        ],
      },
      configuration: { mode: 'backend-owned' },
    },
    onboarding: {
      command: 'pi',
      hint: '首次使用请启动 Pi 并通过 /login 完成认证，或配置 ANTHROPIC_API_KEY 等官方模型变量。',
      probe: { kind: 'pi-auth-check' },
    },
    // pi 没有权限审批机制，任何模式下都等效 full 权限。
    supportsFullPermission: true,
    alwaysFullPermission: true,
    environment: {
      names: [
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_BASE_URL',
        'OPENAI_API_KEY',
        'OPENAI_BASE_URL',
        'GEMINI_API_KEY',
        'GOOGLE_API_KEY',
      ],
      prefixes: ['PI_'],
    },
  }],
  ['acp', {
    id: 'acp',
    label: 'ACP Agent',
    workspaceEnvironment: 'ACP_WORKSPACE',
    // 通用 ACP 接入的 agent 由用户自带，技能目录约定未知；显式声明无约定。
    skills: null,
    setup: {
      commandEnvironment: 'ACP_COMMAND',
      integration: 'generic',
    },
    lifecycle: {
      installation: null,
      configuration: { mode: 'user-managed' },
    },
    supportsFullPermission: false,
    environment: {
      prefixes: ['ACP_'],
      explicitListEnvironment: 'QWEN_AUDIO_AGENT_ACP_FORWARD_ENV',
    },
  }],
])

export function backendDefinition(protocol) {
  return definitions.get(normalizeBackendProtocol(protocol)) || null
}

// skills.sh（npx skills）的 agent id 形态：kebab-case。限定字符集防止
// installer 声明被拼接进命令参数时注入额外 flag。
const SKILLS_INSTALLER_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

// skills 声明是后台接入协议的必填项：要么声明其在 skills.sh 的安装器
// agent id（installer: null 表示经通用目录被动覆盖，无需专属安装），
// 要么显式 skills: null 表示无技能约定。缺失即视为接入不完整，
// 注册与测试直接失败，避免新后台遗漏 SKILL 支持决策。skills.sh
// 未支持的新后台应按其官方扩展点（src/agents.ts）提 PR。
export function validateBackendSkillsSpec(definition) {
  if (definition?.skills === undefined) {
    throw new Error(`后台 ${definition?.id} 缺少 skills 声明（声明 skills.sh 安装器，无约定时显式 null）`)
  }
  const spec = definition.skills
  if (spec === null) return null
  if (spec?.installer === null) return spec
  if (
    typeof spec?.installer !== 'string'
    || !SKILLS_INSTALLER_PATTERN.test(spec.installer)
  ) {
    throw new Error(`后台 ${definition.id} 的 skills.installer 无效：${spec?.installer}`)
  }
  return spec
}

export function backendSkillsSpec(protocol) {
  const definition = backendDefinition(protocol)
  if (!definition) return null
  return validateBackendSkillsSpec(definition)
}

// 供 skill install 透传时组装显式 -a 名单：不依赖 skills.sh 的本机检测
//（检测基于特征目录存在性，hermes 未装 CLI、openclaw 被产品隔离时会漏）。
export function skillsInstallerAgents() {
  return [...new Set(backendDefinitions()
    .map(definition => validateBackendSkillsSpec(definition)?.installer)
    .filter(Boolean))]
}

export function backendNames() {
  return [...definitions.keys()]
}

export function backendDefinitions() {
  return [...definitions.values()]
}

export function resolveBackendOwnership(protocol, {
  baseUrlConfigured = false,
  requestedOwnership = '',
} = {}) {
  const definition = backendDefinition(protocol)
  if (!definition) throw new Error(`不支持的后台 Agent：${protocol}`)
  const requested = String(requestedOwnership || '').trim().toLowerCase()
  if (requested && !['owned', 'external'].includes(requested)) {
    throw new Error(`不支持的后台进程归属：${requested}`)
  }
  if (requested === 'external' && !definition.supportsExternalService) {
    throw new Error(`${definition.label} 不支持连接外部后台服务`)
  }
  if (requested) return requested
  return definition.supportsExternalService && baseUrlConfigured
    ? 'external'
    : 'owned'
}

export function normalizeBackendProtocol(value) {
  const protocol = String(value || '').trim().toLowerCase()
  return protocol === 'none' ? '' : protocol
}

// 部分后台（如 Pi）没有任何权限审批机制，无论用户配置什么都始终运行在
// 最高权限。此类后台通过 alwaysFullPermission 声明，配置解析、健康状态
// 与桌面 UI 统一经本函数归一化，展示真实生效的权限模式而不是用户配置的
// 原始值。本函数不做合法性校验，非法值由各调用方按自身语境报错。
export function effectiveBackendPermissionMode(protocol, mode) {
  const normalized = String(mode || '').trim().toLowerCase() || 'native'
  return backendDefinition(protocol)?.alwaysFullPermission
    ? 'full'
    : normalized
}
