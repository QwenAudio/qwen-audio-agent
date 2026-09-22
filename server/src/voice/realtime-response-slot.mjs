/** A server-reported response can occupy the slot before response.created.
 * Never treat a local timeout as proof that the remote slot was released.
 */
export class RealtimeResponseSlot {
  constructor({ waitMs, cancelMs, cancel, disconnect, diagnostic }) {
    Object.assign(this, { waitMs, cancelMs, cancel, disconnect, diagnostic })
    this.phase = 'idle'
    this.waiters = []
    this.timer = null
  }

  get blocked() { return this.phase !== 'idle' }

  wait() {
    return this.blocked ? new Promise(resolve => this.waiters.push(resolve)) : Promise.resolve()
  }

  occupy() {
    if (this.blocked) return
    this.phase = 'pending'
    this.timer = setTimeout(() => this.recover(), this.waitMs)
    this.timer.unref?.()
  }

  recover() {
    if (this.phase === 'cancelling') return
    clearTimeout(this.timer)
    this.phase = 'cancelling'
    this.diagnostic?.('cancel')
    // Arm before sending: an in-process transport can acknowledge synchronously.
    this.timer = setTimeout(() => {
      this.diagnostic?.('reconnect')
      this.disconnect()
      this.release()
    }, this.cancelMs)
    this.timer.unref?.()
    this.cancel()
  }

  release() {
    clearTimeout(this.timer)
    this.timer = null
    this.phase = 'idle'
    this.waiters.splice(0).forEach(resolve => resolve())
  }
}
