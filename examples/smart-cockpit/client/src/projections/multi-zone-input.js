export const MULTI_ZONE_EVENT = 'cockpit.multi_zone.input'
export const MULTI_ZONE_STATE = 'cockpit.multi_zone'
const PUBLISH = 'client.event.publish'

// Pause capture routing across the acknowledged mode transition. The decision
// session stays connected and keeps its conversation in either mode.
export class CockpitInputRouter {
  constructor(client, { onReady = () => {}, onError = () => {} } = {}) {
    Object.assign(this, { client, onReady, onError })
    this.desired = false
    this.actual = false
    this.ready = false
    this.chain = Promise.resolve()
  }

  setMode(enabled) {
    this.desired = enabled
    this.ready = false
    this.onReady(false)
    this.chain = this.chain.catch(() => {}).then(async () => {
      const target = this.desired
      if (this.actual !== target) {
        await this.publish({ op: target ? 'enable' : 'disable' })
        this.actual = target
      }
      this.ready = this.actual === this.desired
      this.onReady(this.ready)
    })
    return this.chain
  }

  publish(data) { return this.client.request(PUBLISH, { name: MULTI_ZONE_EVENT, data }) }

  audio(audio) {
    if (!this.ready) return false
    return this.client.send({ type: 'audio.append', audio })
  }

  stopAudio() {
    if (this.ready && this.actual) this.publish({ op: 'audio.stop' }).catch(this.onError)
  }

  async text(rows) {
    if (!this.ready || !this.actual) throw new Error('四音区模拟尚未就绪')
    return this.publish({ op: 'text', rows })
  }
}
