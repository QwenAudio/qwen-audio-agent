import electronUpdater from 'electron-updater'

import { friendlyUpdateError, initialUpdateState } from './update-status.mjs'

// 包装 electron-updater：事件归约为统一状态推送给设置页。
// enabled=false（如开发环境）时检查直接失败并给出提示，
// 避免 dev 环境缺少 app-update.yml 时抛出原始异常。
// electron-updater 的 autoUpdater 是惰性 getter，访问即实例化并依赖
// Electron 运行时，因此只能在 createDesktopUpdater 调用时取默认实现，
// 不能在模块顶层解构（Node 测试环境无 Electron）。
export function createDesktopUpdater({
  currentVersion,
  enabled = true,
  notify = () => {},
  impl,
} = {}) {
  const updaterImpl = impl || electronUpdater.autoUpdater
  let state = initialUpdateState(currentVersion)
  const transition = patch => {
    state = { ...state, ...patch }
    notify(state)
  }

  updaterImpl.autoDownload = true
  updaterImpl.autoInstallOnAppQuit = true
  updaterImpl.logger = null

  updaterImpl.on('checking-for-update', () => {
    transition({ phase: 'checking', message: '' })
  })
  updaterImpl.on('update-available', info => {
    transition({
      phase: 'downloading',
      updateVersion: info?.version || '',
      percent: 0,
      message: '',
    })
  })
  updaterImpl.on('update-not-available', () => {
    transition({ phase: 'current', updateVersion: '', percent: 0 })
  })
  updaterImpl.on('download-progress', progress => {
    transition({
      phase: 'downloading',
      percent: Math.round(progress?.percent || 0),
    })
  })
  updaterImpl.on('update-downloaded', info => {
    transition({
      phase: 'downloaded',
      updateVersion: info?.version || state.updateVersion,
      percent: 100,
    })
  })
  updaterImpl.on('error', error => {
    transition({ phase: 'error', message: friendlyUpdateError(error) })
  })

  return {
    state: () => state,
    check: async () => {
      if (!enabled) {
        transition({ phase: 'error', message: '当前环境不支持自动更新' })
        return state
      }
      transition({ phase: 'checking', message: '' })
      try {
        await updaterImpl.checkForUpdates()
      } catch (error) {
        transition({ phase: 'error', message: friendlyUpdateError(error) })
      }
      return state
    },
    install: () => updaterImpl.quitAndInstall(),
  }
}
