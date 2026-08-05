export class DesktopPresence {
  constructor({
    getWindow,
    globalShortcut,
    logger,
  } = {}) {
    this.getWindow = getWindow
    this.globalShortcut = globalShortcut
    this.logger = logger
    this.state = 'active'
    this.shortcut = ''
    this.shortcutRegistered = false
    this.shortcutPaused = false
  }

  send(state, reason = '') {
    this.state = state
    const window = this.getWindow?.()
    if (window && !window.isDestroyed()) {
      window.webContents.send('qwen-audio-agent:lifecycle', { state, reason })
    }
  }

  wake(reason = 'shortcut') {
    const window = this.getWindow?.()
    if (!window || window.isDestroyed()) return false
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
    if (this.state === 'hidden') {
      this.send('waking', reason)
    } else {
      window.webContents.send('qwen-audio-agent:lifecycle', {
        state: this.state,
        reason: 'activity',
      })
    }
    return true
  }

  hide(reason = 'inactivity') {
    const window = this.getWindow?.()
    if (!window || window.isDestroyed() || this.state !== 'active') {
      return this.state
    }
    this.send('hidden', reason)
    window.hide()
    this.logger?.info('desktop.hidden', { reason })
    return this.state
  }

  ready() {
    if (this.state !== 'waking') return false
    this.send('active', 'ready')
    this.logger?.info('desktop.visible')
    return true
  }

  registerShortcut(accelerator) {
    if (this.shortcut === accelerator && this.shortcutRegistered) return true
    const registered = this.globalShortcut.register(
      accelerator,
      () => this.wake('shortcut'),
    )
    if (!registered) return false
    if (this.shortcut && this.shortcut !== accelerator) {
      this.globalShortcut.unregister(this.shortcut)
    }
    this.shortcut = accelerator
    this.shortcutRegistered = true
    return true
  }

  pauseShortcut() {
    if (this.shortcut && this.shortcutRegistered) {
      this.globalShortcut.unregister(this.shortcut)
    }
    this.shortcutPaused = true
    this.shortcutRegistered = false
  }

  resumeShortcut() {
    this.shortcutPaused = false
    this.shortcutRegistered = this.registerShortcut(this.shortcut)
    return this.shortcutRegistered
  }

  destroy() {
    this.globalShortcut.unregisterAll()
    this.shortcutRegistered = false
    this.shortcutPaused = false
  }
}
