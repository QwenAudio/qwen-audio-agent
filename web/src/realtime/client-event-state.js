/** Client-owned environment snapshots, published through ordinary GCP events.
 * Keep only the latest value while offline and resend when Realtime is ready.
 * One-shot events (buttons, sleep requests, etc.) must not use this cache.
 */
export class ClientEventState {
  constructor(publish) {
    this.publish = publish
    this.ready = false
    this.latest = new Map()
  }

  set(name, data) {
    const serialized = JSON.stringify(data)
    if (this.latest.get(name)?.serialized !== serialized) {
      this.latest.set(name, { serialized, sent: false })
    }
    this.flush()
  }

  setReady(ready) {
    this.ready = ready
    if (!ready) {
      for (const entry of this.latest.values()) entry.sent = false
    }
    this.flush()
  }

  flush() {
    if (!this.ready) return
    for (const [name, entry] of this.latest) {
      if (entry.sent) continue
      entry.sent = this.publish(name, JSON.parse(entry.serialized)) === true
    }
  }
}
