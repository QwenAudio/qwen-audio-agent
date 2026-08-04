export const MASKED_SECRET = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'

const FAILURE_PRESENTATIONS = Object.freeze({
  'wsl-unavailable': {
    title: '需要安装或启用 WSL',
    actionText: '完成 Windows WSL 设置后重新检查。',
    primaryAction: 'open-wsl-install',
  },
  'no-distributions': {
    title: '需要安装 WSL 发行版',
    actionText: '安装一个 WSL 2 发行版后重新检查。',
    primaryAction: 'open-wsl-install',
  },
  'distribution-not-found': {
    title: '所选 WSL 发行版不可用',
    actionText: '选择当前可用的发行版并重试。',
    primaryAction: 'retry',
  },
  'wsl2-required': {
    title: '所选发行版需要 WSL 2',
    actionText: '将发行版升级到 WSL 2 后重新检查。',
    primaryAction: 'open-wsl-install',
  },
  'unsupported-architecture': {
    title: '当前 WSL 架构不受支持',
    actionText: '请选择 x64 或 arm64 Linux 发行版。',
    primaryAction: 'none',
  },
  'node-required': {
    title: 'WSL 中需要 Node.js 和 npm',
    actionText: '在所选发行版中安装 Node.js 22 或更高版本。',
    primaryAction: 'open-node-download',
  },
  'runtime-required': {
    title: '需要安装运行环境',
    actionText: '确认本地安装命令后开始安装。',
    primaryAction: 'prepare-install',
  },
  'runtime-install-failed': {
    title: '运行环境安装未完成',
    actionText: '重新确认安装命令并重试。',
    primaryAction: 'prepare-install',
  },
  'runtime-integrity-failed': {
    title: '安装包完整性校验失败',
    actionText: '请重新安装当前版本的 Windows 客户端。',
    primaryAction: 'retry',
  },
  'runtime-verification-failed': {
    title: '运行环境校验失败',
    actionText: '重新安装与客户端匹配的运行环境。',
    primaryAction: 'prepare-install',
  },
  'bridge-handshake-failed': {
    title: 'WSL 连接协议不匹配',
    actionText: '同步与客户端匹配的运行环境。',
    primaryAction: 'prepare-install',
  },
  'runtime-promotion-failed': {
    title: '运行环境切换未完成',
    actionText: '当前健康版本仍可用，可以重新同步。',
    primaryAction: 'prepare-install',
  },
  'bridge-recovery-exhausted': {
    title: 'WSL 连接多次中断',
    actionText: '检查发行版状态后重新连接。',
    primaryAction: 'retry',
  },
  'bridge-exited': {
    title: 'WSL 连接已中断',
    actionText: '正在尝试恢复连接。',
    primaryAction: 'retry',
  },
  'gateway-start-failed': {
    title: 'Gateway 启动失败',
    actionText: '检查运行日志后重新启动。',
    primaryAction: 'retry',
  },
  'gateway-health-timeout': {
    title: 'Windows 无法连接 Gateway',
    actionText: '检查 Windows 与 WSL 的 localhost 转发。',
    primaryAction: 'open-wsl-networking',
  },
  'external-invalid': {
    title: '外部 Gateway 地址无效',
    actionText: '请输入带端口的本机 HTTP 地址。',
    primaryAction: 'none',
  },
  'external-unavailable': {
    title: '外部 Gateway 暂不可用',
    actionText: '确认本机 Gateway 已启动后重试。',
    primaryAction: 'retry',
  },
  'confirmation-required': {
    title: '需要重新确认操作',
    actionText: '重新获取操作详情后继续。',
    primaryAction: 'retry',
  },
  'confirmation-expired': {
    title: '操作确认已过期',
    actionText: '重新获取操作详情后继续。',
    primaryAction: 'retry',
  },
  'removal-target-changed': {
    title: '运行环境位置已变化',
    actionText: '重新检查移除目标后继续。',
    primaryAction: 'retry',
  },
  'runtime-removal-failed': {
    title: '运行环境移除失败',
    actionText: '确认 WSL 可用后重试。',
    primaryAction: 'retry',
  },
  cancelled: {
    title: '安装已取消',
    actionText: '可以随时重新开始安装。',
    primaryAction: 'retry',
  },
  'microphone-denied': {
    title: '需要麦克风权限',
    actionText: '在 Windows 隐私设置中允许麦克风访问。',
    primaryAction: 'open-microphone-settings',
  },
})

const STATE_PRESENTATIONS = Object.freeze({
  checking: {
    title: '正在检查 WSL',
    actionText: '正在读取 Windows 和 WSL 运行状态。',
    primaryAction: 'none',
  },
  'setup-required': {
    title: '需要完成运行环境设置',
    actionText: '完成所需项目后即可启动。',
    primaryAction: 'retry',
  },
  starting: {
    title: '正在启动运行环境',
    actionText: '正在连接 WSL 并启动 Gateway。',
    primaryAction: 'none',
  },
  ready: {
    title: '运行环境已就绪',
    actionText: 'WSL 与 Gateway 连接正常。',
    primaryAction: 'none',
  },
  recovering: {
    title: '正在重新连接 WSL',
    actionText: '窗口会保留，连接恢复后自动继续。',
    primaryAction: 'none',
  },
  external: {
    title: '外部 Gateway 已连接',
    actionText: '客户端不会启动或停止这个 Gateway。',
    primaryAction: 'none',
  },
  error: {
    title: '运行环境暂不可用',
    actionText: '检查状态后重试。',
    primaryAction: 'retry',
  },
  stopping: {
    title: '正在停止运行环境',
    actionText: '正在安全关闭托管会话。',
    primaryAction: 'none',
  },
})

const PROGRESS_LABELS = Object.freeze({
  preparing: '正在准备安装',
  copying: '正在复制安装包',
  installing: '正在安装运行环境',
  verifying: '正在校验运行环境',
})

const PRIMARY_LABELS = Object.freeze({
  retry: '重新检查',
  'prepare-install': '准备安装',
  'open-wsl-install': '查看 WSL 安装',
  'open-node-download': '查看 Node.js 安装',
  'open-wsl-networking': '查看网络修复',
  'open-microphone-settings': '麦克风设置',
  'open-orb': '打开主窗口',
})

const SYNC_PRESENTATION = Object.freeze({
  title: '运行环境可以同步',
  actionText: '可安装与当前客户端匹配的运行环境。',
  primaryAction: 'prepare-install',
})

const ORB_HANDOFF_FAILURE_PRESENTATION = Object.freeze({
  title: '主窗口未打开',
  actionText: '运行环境已安装，请重新打开主窗口。',
  primaryAction: 'open-orb',
})

function check(id, label, state, value) {
  return { id, label, state, value }
}

function presentChecks(status, environment) {
  const reason = status.reason
  const unavailable = reason === 'wsl-unavailable'
  const noDistribution = ['no-distributions', 'distribution-not-found'].includes(reason)
  const wrongWslVersion = reason === 'wsl2-required'
  const invalidProbe = reason === 'invalid-probe'
  const nodeRequired = reason === 'node-required'
  const runtimeFailed = [
    'runtime-required',
    'runtime-install-failed',
    'runtime-integrity-failed',
    'runtime-verification-failed',
    'bridge-handshake-failed',
  ].includes(reason)
  const gatewayFailed = [
    'gateway-start-failed',
    'gateway-health-timeout',
    'external-unavailable',
  ].includes(reason)
  const health = status.health || {}
  const backend = health.backend
  const microphoneDenied = status.reason === 'microphone-denied'
    || ['denied', 'restricted'].includes(status.microphoneAccess)
  return [
    check(
      'wsl',
      'WSL',
      unavailable ? 'failed' : status.state === 'checking' ? 'checking' : 'ready',
      unavailable ? '不可用' : '已启用',
    ),
    check(
      'distribution',
      '发行版',
      noDistribution ? 'failed' : environment.distribution ? 'ready' : 'unknown',
      environment.distribution || '未选择',
    ),
    check(
      'wsl-version',
      'WSL 版本',
      wrongWslVersion ? 'failed' : environment.wslVersion === 2 ? 'ready' : 'unknown',
      environment.wslVersion ? `WSL ${environment.wslVersion}` : '待检查',
    ),
    check(
      'bash',
      'Bash 登录环境',
      invalidProbe ? 'failed' : environment.distribution ? 'ready' : 'unknown',
      invalidProbe ? '检查失败' : environment.distribution ? '可用' : '待检查',
    ),
    check(
      'node',
      'Node.js 与 npm',
      nodeRequired ? 'failed' : environment.nodeVersion ? 'ready' : 'unknown',
      environment.nodeVersion
        ? `Node.js ${environment.nodeVersion}${environment.npmVersion ? ` · npm ${environment.npmVersion}` : ''}`
        : '待检查',
    ),
    check(
      'runtime',
      '专用运行环境',
      runtimeFailed ? 'failed' : environment.runtimeVersion ? 'ready' : 'unknown',
      environment.runtimeVersion
        ? `v${environment.runtimeVersion} · 协议 ${environment.protocolVersion || '-'}`
        : '未安装',
    ),
    check(
      'backend',
      '后台 Agent',
      backend ? backend.connected ? 'ready' : 'failed' : 'unknown',
      backend?.label || '启动后检查',
    ),
    check(
      'gateway',
      'Gateway 与 localhost',
      gatewayFailed
        ? 'failed'
        : health.gatewayConnected || status.state === 'ready' ? 'ready' : 'checking',
      health.gatewayConnected || status.state === 'ready' ? '已连接' : gatewayFailed ? '连接失败' : '待连接',
    ),
    check(
      'microphone',
      'Windows 麦克风',
      microphoneDenied ? 'failed' : status.microphoneAccess === 'granted' ? 'ready' : 'unknown',
      microphoneDenied
        ? '需要授权'
        : status.microphoneAccess === 'granted' ? '已允许' : '使用时检查',
    ),
  ]
}

function presentProgress(progress) {
  if (!progress || typeof progress !== 'object') {
    return { visible: false, label: '', value: 0 }
  }
  const completed = Number(progress.completed)
  const total = Number(progress.total)
  const value = Number.isFinite(completed) && Number.isFinite(total) && total > 0
    ? Math.max(0, Math.min(100, Math.round(completed / total * 100)))
    : 0
  return {
    visible: true,
    label: PROGRESS_LABELS[progress.phase] || '正在更新运行环境',
    value,
  }
}

export function requiresOrbHandoffRetry(result) {
  return result?.orbPresented === false
}

export function runtimePresentation({
  status = {},
  environment = {},
  installPlan = null,
  orbHandoffFailed = false,
} = {}) {
  const stateCopy = STATE_PRESENTATIONS[status.state]
    || STATE_PRESENTATIONS.error
  const failureCopy = FAILURE_PRESENTATIONS[status.reason]
  const syncing = status.state === 'ready'
    && status.syncAvailable === true
    && !failureCopy
  const handoffCopy = orbHandoffFailed
    && ['ready', 'external'].includes(status.state)
    ? ORB_HANDOFF_FAILURE_PRESENTATION
    : null
  const copy = handoffCopy
    || failureCopy
    || (syncing ? SYNC_PRESENTATION : stateCopy)
  const installAction = copy.primaryAction === 'prepare-install'
  return {
    title: copy.title,
    actionText: copy.actionText,
    primaryAction: copy.primaryAction,
    primaryLabel: copy === SYNC_PRESENTATION
      ? '准备同步'
      : PRIMARY_LABELS[copy.primaryAction] || '',
    showCommandConfirmation: Boolean(
      installAction && typeof installPlan?.displayCommand === 'string',
    ),
    offerMicrophoneSettings: status.reason === 'microphone-denied'
      || ['denied', 'restricted'].includes(status.microphoneAccess),
    tone: ['ready', 'external'].includes(status.state)
      && status.reason !== 'external-unavailable'
      ? 'ready'
      : ['checking', 'starting', 'recovering', 'stopping'].includes(status.state)
        ? 'working'
        : failureCopy ? 'error' : 'neutral',
    progress: presentProgress(status.progress),
    checks: presentChecks(status, environment),
  }
}

export function secretFieldDisplayValue(value) {
  if (value && typeof value === 'object') {
    return value.configured === true ? MASKED_SECRET : ''
  }
  return String(value || '')
}

export function secretSettingUpdateValue(original, displayedValue) {
  const value = String(displayedValue ?? '')
  if (
    original
    && typeof original === 'object'
    && original.configured === true
    && value === MASKED_SECRET
  ) return { configured: true }
  return value
}
