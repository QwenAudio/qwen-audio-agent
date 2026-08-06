export class SleepController {
  constructor({
    timeoutMs,
    retryMs = 1000,
    canSleep = () => true,
    onSleep = () => {},
  } = {}) {
    this.timeoutMs = Math.max(0, Number(timeoutMs) || 0)
    this.retryMs = Math.max(10, Number(retryMs) || 1000)
    this.canSleep = canSleep
    this.onSleep = onSleep
    this.enabled = false
    this.sleeping = false
    this.closed = false
    this.timer = null
  }

  enable() {
    if (this.closed) return false
    this.enabled = true
    if (this.timeoutMs) this.recordActivity()
    return true
  }

  recordActivity() {
    if (!this.enabled || this.sleeping || this.closed) return
    this.schedule(this.timeoutMs)
  }

  schedule(delay) {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.trySleep(), delay)
    this.timer.unref?.()
  }

  async trySleep() {
    this.timer = null
    if (!this.enabled || this.sleeping || this.closed) return
    if (!this.canSleep()) {
      this.schedule(this.retryMs)
      return
    }
    this.sleeping = true
    try {
      await this.onSleep()
    } catch {
      this.sleeping = false
      this.schedule(this.retryMs)
    }
  }

  wake() {
    if (this.closed) return false
    const wasSleeping = this.sleeping
    this.sleeping = false
    if (this.enabled) this.recordActivity()
    return wasSleeping
  }

  holdSleeping() {
    if (!this.enabled || this.closed) return false
    clearTimeout(this.timer)
    this.timer = null
    this.sleeping = true
    return true
  }

  disable() {
    this.enabled = false
    this.sleeping = false
    clearTimeout(this.timer)
    this.timer = null
  }

  close() {
    this.closed = true
    this.disable()
  }
}
