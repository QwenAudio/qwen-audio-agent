export class NativeInputFeature {
  constructor({
    enabled = false,
    accelerator = 'CommandOrControl+Shift+D',
    globalShortcut,
    host,
  } = {}) {
    this.enabled = enabled === true
    this.accelerator = accelerator
    this.globalShortcut = globalShortcut
    this.host = host
    this.state = this.enabled ? 'idle' : 'disabled'
    this.shortcutRegistered = false
    this.initializing = null
  }

  snapshot() {
    return {
      enabled: this.enabled,
      state: this.state,
      shortcutRegistered: this.shortcutRegistered,
    }
  }

  initialize() {
    if (!this.enabled) return Promise.resolve(this.snapshot())
    if (this.state === 'ready') return Promise.resolve(this.snapshot())
    if (this.initializing) return this.initializing
    this.initializing = this.startEnabled()
      .finally(() => { this.initializing = null })
    return this.initializing
  }

  async startEnabled() {
    this.state = 'starting'
    await this.host.start()
    const registered = this.globalShortcut.register(
      this.accelerator,
      () => this.handleShortcut(),
    )
    if (!registered) {
      this.state = 'error'
      await this.host.stop('shortcut_unavailable')
      throw new Error('Native input shortcut is unavailable')
    }
    this.shortcutRegistered = true
    this.state = 'ready'
    return this.snapshot()
  }

  handleShortcut() {
    if (!this.enabled || this.state !== 'ready') return false
    try {
      this.host.send({ type: 'session.arm' })
      return true
    } catch {
      this.unregisterShortcut()
      this.state = 'error'
      this.host.emergencyStop('shortcut_dispatch_failed')
      return false
    }
  }

  sendOperation(message) {
    if (!this.enabled || this.state !== 'ready') {
      throw new Error('Native input is not ready')
    }
    this.host.send(message)
    return true
  }

  rendererLost() {
    if (!this.enabled || this.state === 'disabled') return false
    this.unregisterShortcut()
    this.state = 'error'
    this.host.emergencyStop('renderer_lost')
    return true
  }

  async shutdown() {
    this.unregisterShortcut()
    this.enabled = false
    await this.host.stop('desktop_shutdown')
    this.state = 'disabled'
    return this.snapshot()
  }

  unregisterShortcut() {
    if (!this.shortcutRegistered) return
    this.globalShortcut.unregister(this.accelerator)
    this.shortcutRegistered = false
  }
}
