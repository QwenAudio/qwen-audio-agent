// 设置页"后台 Agent"下拉列表的展示状态计算。
// 输入是 shared/backend-setup.mjs 的 inspectBackendSetups() 报告，
// 保持纯函数，浏览器渲染层与 Node 测试共用同一份逻辑。

export const NONE_OPTION_ID = 'none'

export const NONE_OPTION_LABEL = '不使用后台 Agent'

// 列表空间有限，把 issue 文案归并为短标签；完整原因放进 option 的 title。
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

export function backendOptionStates(report) {
  const states = [{
    id: NONE_OPTION_ID,
    label: NONE_OPTION_LABEL,
    disabled: false,
    title: '',
  }]
  for (const item of report?.backends || []) {
    const ready = item.ready === true
    states.push({
      id: item.id,
      label: ready
        ? item.label || item.id
        : `${item.label || item.id}（${shortReason(item.issues)}）`,
      // 当前生效的配置项即使不可用也保持可选，否则下拉框无法显示
      // 当前值，用户也无法通过它改回其他选项。
      disabled: !ready && item.selected !== true,
      title: ready ? '' : String(item.issues?.[0] || '').trim(),
    })
  }
  return states
}
