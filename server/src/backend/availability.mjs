// Cached backend availability for receipt-based tool acceptance. The voice
// frontend must hand out spawn_thinking receipts in milliseconds, so it can
// never block on a live health probe. This cache answers synchronously from
// the last known state and refreshes itself in the background; a backend
// that looks healthy here but fails at dispatch surfaces through the
// failed-task announcement path instead of the tool receipt.
export class BackendAvailability {
  constructor({
    probe,
    ttlMs = 15_000,
    retryMs = 500,
    now = () => Date.now(),
  } = {}) {
    if (typeof probe !== 'function') {
      throw new Error('BackendAvailability requires a probe')
    }
    this.probe = probe
    this.ttlMs = ttlMs
    this.retryMs = retryMs
    this.now = now
    this.last = null
    this.transient = false
    this.checkedAt = 0
    this.refreshing = null
    this.retryTimer = null
    this.closed = false
  }

  // Synchronous view. `known: false` means no probe has completed yet — the
  // caller should accept optimistically and let dispatch report failures.
  snapshot() {
    if (this.now() - this.checkedAt >= this.ttlMs) this.refresh()
    if (!this.last) return { configured: true, ok: true, known: false }
    const refreshingNegative = this.refreshing
      && this.last.ok === false
      && this.last.configured !== false
    return { ...this.last, known: !this.transient && !refreshingNegative }
  }

  // Starting: re-probe soon. Unreachable: re-probe once per TTL, so a backend that
  // came back is seen before the next receipt asks. Not configured: leave it.
  scheduleRetry() {
    if (this.closed || this.retryTimer) return
    const delayMs = this.transient
      ? this.retryMs
      : this.last?.ok === false && this.last.configured !== false ? this.ttlMs : 0
    if (!delayMs) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.refresh()
    }, delayMs)
    this.retryTimer.unref?.()
  }

  // Background refresh; concurrent callers share one probe and the promise
  // never rejects, so fire-and-forget call sites stay silent.
  refresh() {
    if (this.refreshing) return this.refreshing
    this.refreshing = Promise.resolve()
      .then(() => this.probe())
      .then(result => {
        this.last = {
          configured: result?.configured !== false,
          ok: result?.ok === true,
        }
        this.transient = result?.transient === true
      })
      .catch(() => {
        // A failing probe is itself evidence the backend is unreachable.
        this.last = {
          configured: this.last?.configured !== false,
          ok: false,
        }
        this.transient = false
      })
      .finally(() => {
        this.checkedAt = this.now()
        this.refreshing = null
        this.scheduleRetry()
      })
    return this.refreshing
  }

  close() {
    this.closed = true
    clearTimeout(this.retryTimer)
    this.retryTimer = null
  }
}
