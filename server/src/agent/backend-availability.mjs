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
    now = () => Date.now(),
  } = {}) {
    if (typeof probe !== 'function') {
      throw new Error('BackendAvailability requires a probe')
    }
    this.probe = probe
    this.ttlMs = ttlMs
    this.now = now
    this.last = null
    this.checkedAt = 0
    this.refreshing = null
  }

  // Synchronous view. `known: false` means no probe has completed yet — the
  // caller should accept optimistically and let dispatch report failures.
  snapshot() {
    if (this.now() - this.checkedAt >= this.ttlMs) this.refresh()
    if (!this.last) return { configured: true, ok: true, known: false }
    return { ...this.last, known: true }
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
      })
      .catch(() => {
        // A failing probe is itself evidence the backend is unreachable.
        this.last = {
          configured: this.last?.configured !== false,
          ok: false,
        }
      })
      .finally(() => {
        this.checkedAt = this.now()
        this.refreshing = null
      })
    return this.refreshing
  }
}
