// 桌面版自动更新的状态模型与展示文案。
// 纯逻辑模块：主进程接线（updater.mjs）、设置页渲染（settings.js）
// 与 Node 测试三方共用，不引入 electron 或 node 内置模块。

export function initialUpdateState(currentVersion) {
  return {
    phase: 'idle',
    currentVersion,
    updateVersion: '',
    percent: 0,
    message: '',
  }
}

export function friendlyUpdateError(error) {
  const text = String(error?.message || error || '').trim()
  const firstLine = text.split('\n')[0].trim()
  if (/latest-mac\.yml|latest\.yml|404/.test(firstLine)) {
    return '暂未发布可用于自动更新的版本'
  }
  if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|network|net::/i.test(firstLine)) {
    return '网络连接失败，请稍后重试'
  }
  if (/code sign|not signed|signature/i.test(firstLine)) {
    return '当前安装包未签名，无法自动更新'
  }
  return firstLine.slice(0, 120) || '检查更新失败'
}

export function updaterStatusText(status) {
  const version = status?.currentVersion || ''
  switch (status?.phase) {
    case 'checking':
      return `${version} · 正在检查更新…`
    case 'downloading': {
      const percent = status.percent > 0 ? ` ${status.percent}%` : ''
      return `发现新版本 ${status.updateVersion}，正在下载${percent}…`
    }
    case 'downloaded':
      return `新版本 ${status.updateVersion} 已就绪`
    case 'current':
      return `${version} · 已是最新版本`
    case 'error':
      return `${version} · ${status.message || '检查更新失败'}`
    default:
      return version
  }
}

export function updaterButtonState(status) {
  if (status?.phase === 'downloaded') {
    return { label: '重启更新', action: 'install', disabled: false }
  }
  if (status?.phase === 'checking' || status?.phase === 'downloading') {
    return { label: '检查更新', action: 'check', disabled: true }
  }
  return { label: '检查更新', action: 'check', disabled: false }
}
