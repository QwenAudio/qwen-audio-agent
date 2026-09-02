import { ClientActionName } from './client-action-port.mjs'

export const PresenceState = Object.freeze({
  ACTIVE: 'active',
  SLEEP_REQUESTED: 'sleep_requested',
  SLEEPING: 'sleeping',
})

/**
 * Idempotent state machine shared by model tools and Gateway sleep triggers.
 * The environment transition is authoritative: sleeping is committed only
 * after the active Client reports that its action completed.
 */
export class PresenceController {
  constructor({
    clientActions,
    beforeSleep = async () => {},
    onSleeping = () => {},
    onFailure = () => {},
  } = {}) {
    this.clientActions = clientActions
    this.beforeSleep = beforeSleep
    this.onSleeping = onSleeping
    this.onFailure = onFailure
    this.state = PresenceState.ACTIVE
    this.pending = null
  }

  supportsSleep() {
    return this.clientActions?.supports(ClientActionName.ENTER_SLEEP) === true
  }

  requestSleep({ source = 'gateway', requireClientAction = true } = {}) {
    if (this.state === PresenceState.SLEEPING) {
      return Promise.resolve({ status: 'completed', state: this.state, duplicate: true })
    }
    if (this.pending) return this.pending
    if (requireClientAction && !this.supportsSleep()) {
      const error = new Error('当前入口不支持休眠。')
      error.code = 'client_action_unsupported'
      return Promise.reject(error)
    }

    this.state = PresenceState.SLEEP_REQUESTED
    const pending = Promise.resolve()
      .then(() => this.beforeSleep({ source }))
      .then(() => requireClientAction
        ? this.clientActions.request(
            ClientActionName.ENTER_SLEEP,
            { source },
            { idempotencyKey: 'presence.sleep' },
          )
        : { status: 'completed', handledBy: 'gateway' })
      .then(result => {
        this.state = PresenceState.SLEEPING
        // Resolve action waiters before closing the Realtime frontend. A model
        // tool can then receive its function result, while the state itself is
        // already authoritative because the Client Action has completed.
        const transition = setTimeout(() => {
          if (this.state === PresenceState.SLEEPING) {
            this.onSleeping({ source, result })
          }
        }, 0)
        transition.unref?.()
        return { status: 'completed', state: this.state, result }
      })
      .catch(error => {
        this.state = PresenceState.ACTIVE
        this.onFailure({ source, error })
        throw error
      })
      .finally(() => {
        if (this.pending === pending) this.pending = null
      })
    this.pending = pending
    return pending
  }

  wake() {
    this.state = PresenceState.ACTIVE
  }

  close() {
    this.clientActions?.close()
    this.pending = null
    this.state = PresenceState.ACTIVE
  }
}
