export class NativeInputDictationClient {
  constructor({
    enabled = false,
    canStart = () => false,
    sendGateway = () => false,
    sendNative = () => Promise.reject(new Error('Native input unavailable')),
    setCapture = () => {},
    onView = () => {},
  } = {}) {
    this.enabled = enabled === true
    this.canStart = canStart
    this.sendGateway = sendGateway
    this.sendNative = sendNative
    this.setCapture = setCapture
    this.onView = onView
    this.active = false
    this.state = this.enabled ? 'idle' : 'disabled'
    this.error = ''
    this.generation = 0
    this.pending = Promise.resolve()
  }

  view() {
    return { enabled: this.enabled, active: this.active, state: this.state, error: this.error }
  }

  publish() { this.onView(this.view()) }
  settled() { return this.pending }

  async start({ continuous = true } = {}) {
    if (!this.enabled || this.active || !this.canStart()) return false
    const generation = ++this.generation
    this.state = 'arming'
    this.error = ''
    this.publish()
    let armed
    try {
      const operationId = crypto.randomUUID()
      const result = await this.sendNative({ type: 'session.arm', operationId })
      armed = result?.type === 'operation.result'
        && result.operationId === operationId
        && result.accepted === true
      if (!armed && typeof result?.reason === 'string') {
        this.error = nativeInputArmError(result.reason)
      }
    } catch (error) {
      this.error = error?.message || String(error)
      armed = false
    }
    if (!armed || generation !== this.generation) {
      this.state = 'error'
      if (!this.error) this.error = 'Native input target is unavailable'
      this.publish()
      return false
    }
    const sent = this.sendGateway({
      type: 'dictation.start', text: '', revision: 0,
      continuous: continuous !== false,
    }) === true
    if (!sent) {
      this.state = 'error'
      this.error = 'Gateway is unavailable'
      await this.safeNativeCancel('gateway_unavailable')
      this.publish()
      return false
    }
    this.active = true
    this.state = 'starting'
    this.setCapture(true)
    this.publish()
    return true
  }

  cancel(reason = 'cancelled') {
    if (!this.active && !['arming', 'starting'].includes(this.state)) return false
    this.generation += 1
    this.active = false
    this.sendGateway({ type: 'dictation.cancel' })
    this.setCapture(false, { restore: true })
    this.state = reason === 'user_cancelled' ? 'cancelled' : 'error'
    this.error = this.state === 'error' ? String(reason) : ''
    this.pending = this.pending.then(() => this.safeNativeCancel(reason))
    this.publish()
    return true
  }

  handle(event = {}) {
    if (!this.enabled) return false
    if (event.type === 'input.suspend') return this.cancel('input_suspended')
    if (event.type === 'dictation.state') {
      const state = String(event.state || '')
      if (['cancelled', 'error', 'stopped'].includes(state)) {
        if (this.active) {
          this.generation += 1
          this.active = false
          this.setCapture(false, { restore: true })
          this.pending = this.pending.then(() => this.safeNativeCancel(state))
        }
        this.state = state
        this.error = state === 'error' ? String(event.message || 'Dictation failed') : ''
        this.publish()
        return true
      }
      if (this.active) {
        this.state = state
        this.publish()
        return true
      }
      return false
    }
    if (!this.active) return false
    if (!['dictation.partial', 'dictation.final', 'dictation.operation'].includes(event.type)) {
      return false
    }
    const generation = this.generation
    const operation = nativeOperation(event)
    this.pending = this.pending
      .then(() => this.sendNative(operation))
      .then(result => {
        if (generation !== this.generation || !this.active) return false
        if (
          result?.type !== 'operation.result'
          || result.operationId !== operation.operationId
          || result.accepted !== true
        ) {
          this.failNative(result?.reason || 'native_operation_failed')
          return false
        }
        return true
      })
      .catch(error => {
        if (generation === this.generation && this.active) {
          this.failNative(error?.message || String(error))
        }
        return false
      })
    return true
  }

  failNative(reason) {
    this.generation += 1
    this.active = false
    this.state = 'error'
    this.error = String(reason || 'Native input failed')
    this.sendGateway({ type: 'dictation.cancel' })
    this.setCapture(false, { restore: true })
    this.publish()
  }

  async safeNativeCancel(reason) {
    try {
      await this.sendNative({
        type: 'session.cancel',
        operationId: crypto.randomUUID(),
        reason,
      })
    } catch {
      // Terminal cleanup is best-effort after capture and Gateway stop locally.
    }
  }
}

function nativeInputArmError(reason) {
  if (reason === 'input_source_selection_required') {
    return 'Select Qwen Input from the macOS input menu'
  }
  return String(reason || 'Native input target is unavailable')
}

export function consumeNativeInputEvents(events, afterId, handle) {
  let cursor = Number.isInteger(afterId) ? afterId : 0
  for (const item of events || []) {
    if (!Number.isInteger(item?.id) || item.id <= cursor) continue
    cursor = item.id
    handle(item.event)
  }
  return cursor
}

function nativeOperation(event) {
  const type = event.type === 'dictation.operation'
    ? 'session.operation'
    : event.type.replace('dictation.', 'session.')
  return {
    type,
    operationId: crypto.randomUUID(),
    ...(typeof event.text === 'string' ? { text: event.text } : {}),
    ...(Number.isInteger(event.revision) ? { revision: event.revision } : {}),
    ...(Number.isInteger(event.seq) ? { seq: event.seq } : {}),
    ...(event.operation ? { operation: event.operation } : {}),
    ...(event.target ? { target: event.target } : {}),
    ...(event.replacement ? { replacement: event.replacement } : {}),
  }
}
