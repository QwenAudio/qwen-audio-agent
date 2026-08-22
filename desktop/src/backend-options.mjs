// 设置页"后台 Agent"列表的行状态计算。
// 输入是主进程附加生命周期后的检测报告，保持纯函数，浏览器渲染层与
// Node 测试共用同一份逻辑。

export const NONE_OPTION_ID = 'none'

export const NONE_OPTION_LABEL = '不使用后台 Agent'

// 列表空间有限，把 issue 文案归并为短徽标；完整原因放进一行的 title。
function shortReason(issues) {
  const text = String(issues?.[0] || '').trim()
  if (!text) return '当前不可用'
  if (/未找到|PATH 中未找到/.test(text)) return '未安装'
  if (/低于最低版本|不兼容|无法确认.*版本/.test(text)) return '版本不兼容'
  if (/DASHSCOPE_API_KEY|QWEN_AUDIO_AGENT_BACKEND_MODEL/.test(text)) {
    return '缺少百炼配置'
  }
  if (/ACP Adapter|缺少 \S+，并且 npx 不可用/.test(text)) return '需要 ACP 适配器'
  if (/指定的命令不可用|指定的 ACP Adapter 不可用|请设置/.test(text)) {
    return '需要配置'
  }
  return '当前不可用'
}

// 行状态：{ id, label, ready, selectable, installable, requiresConfirmation,
// reason, title }。installable 为 true 时渲染层在行尾显示"安装"按钮。
export function backendOptionStates(report) {
  const states = [{
    id: NONE_OPTION_ID,
    label: NONE_OPTION_LABEL,
    ready: true,
    selectable: true,
    installable: false,
    requiresConfirmation: false,
    configurationRequired: false,
    configurable: false,
    reason: '',
    title: '',
  }]
  for (const item of report?.backends || []) {
    if (item.id === 'acp') continue
    const ready = item.ready === true
    const install = item.install || {}
    const configuration = item.onboarding?.configuration || {}
    const configurationRequired = configuration.required === true
    const configurationReady = configuration.status === 'authenticated'
    states.push({
      id: item.id,
      label: item.label || item.id,
      ready,
      // 当前生效的配置项即使不可用也保持可选，否则列表无法呈现当前值，
      // 用户也无法通过它改回其他选项。
      selectable: ready || item.selected === true,
      // 仅"不可用且支持一键安装"时显示安装按钮；acp 等无安装规格的
      // 后台由 installSupport 标记 supported:false，自然不显示按钮。
      installable: !ready && install.supported === true,
      requiresConfirmation: install.requiresConfirmation === true,
      configurationRequired,
      configurationReady,
      configurable: (
        ready
        && configuration.action != null
        && configuration.actionAvailable !== false
        && configuration.status !== 'authenticated'
      ),
      configurationLabel: configuration.action?.label || '配置',
      configurationHint: configuration.action?.hint || '',
      onboardingState: item.onboarding?.state || (
        configurationRequired ? 'configuration-required' : (
          ready ? 'installed' : 'not-installed'
        )
      ),
      statusLabel: configurationRequired
        ? '待配置'
        : ready
          ? configurationReady ? '已就绪' : '已安装'
          : shortReason(item.issues),
      reason: ready ? '' : shortReason(item.issues),
      title: ready
        ? ''
        : String(item.issues?.[0] || install.reason || '').trim(),
      ...(item.externalService?.supported
        ? { externalService: { ...item.externalService } }
        : {}),
    })
  }
  return states
}

export function backendRuntimeReady(state, {
  selectedBackend,
  runtimeBackend,
} = {}) {
  return Boolean(
    state?.ready === true
    && state.configurationRequired !== true
    && state.id === selectedBackend
    && runtimeBackend?.connected === true,
  )
}

// Installation/configuration comes from the onboarding contract, while the
// live connection comes from Gateway. Keep the precedence here so every UI
// surface describes an installed-but-unconfigured backend consistently
// instead of presenting the expected ACP startup failure as "unavailable".
export function backendRuntimePhase(state, runtimeBackend) {
  if (state?.ready === true && state.configurationRequired === true) {
    return 'configuration-required'
  }
  if (!runtimeBackend) return 'not-configured'
  if (runtimeBackend.connected === true) return 'connected'
  if (
    runtimeBackend.status === 'starting'
    || ['NOT_STARTED', 'STARTING', 'BACKEND_STARTING'].includes(
      runtimeBackend.code,
    )
  ) return 'starting'
  if (runtimeBackend.error) return 'connection-failed'
  return 'disconnected'
}
