import {
  createGatewayProtocolEventId,
  GatewayClientActionName,
  GatewayClientCapability,
  GatewayClientProtocolEvent,
  GatewayClientActionResultSchema,
} from '../../../shared/gateway-client-protocol.mjs'

export const ClientActionName = GatewayClientActionName

const ACTION_CAPABILITIES = Object.freeze({
  [ClientActionName.ENTER_SLEEP]: GatewayClientCapability.CLIENT_ACTION_ENTER_SLEEP,
})

export function clientActionCapability(name) {
  return ACTION_CAPABILITIES[String(name || '')] || null
}

function actionError(code, message, details = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, details)
  return error
}

/**
 * Protocol-neutral Gateway-to-Client action boundary.
 *
 * The port owns correlation, deadlines, capability checks and duplicate
 * in-flight requests. Client implementations own the environment operation.
 */
export class ClientActionPort {
  constructor({
    send,
    getCapabilities = () => [],
    capabilityForAction = clientActionCapability,
    timeoutMs = 5_000,
    createEventId = () => createGatewayProtocolEventId('gateway'),
  } = {}) {
    this.send = send
    this.getCapabilities = getCapabilities
    this.capabilityForAction = capabilityForAction
    this.timeoutMs = Math.max(100, Number(timeoutMs) || 5_000)
    this.createEventId = createEventId
    this.pendingById = new Map()
    this.pendingByKey = new Map()
  }

  supports(name) {
    const capability = this.capabilityForAction(String(name || ''))
    return Boolean(
      capability
      && new Set(this.getCapabilities?.() || []).has(capability),
    )
  }

  request(name, argumentsValue = {}, {
    idempotencyKey = '',
    timeoutMs = this.timeoutMs,
  } = {}) {
    const actionName = String(name || '').trim()
    const capability = this.capabilityForAction(actionName)
    if (!capability || !this.supports(actionName)) {
      return Promise.reject(actionError(
        'client_action_unsupported',
        `Client does not support ${actionName || 'this action'}`,
      ))
    }
    if (typeof this.send !== 'function') {
      return Promise.reject(actionError(
        'client_action_unavailable',
        'No active Client Action transport is available',
      ))
    }
    const key = String(idempotencyKey || '').trim()
    if (key && this.pendingByKey.has(key)) return this.pendingByKey.get(key).promise

    const requestId = this.createEventId()
    const deferred = Promise.withResolvers()
    const pending = {
      requestId,
      name: actionName,
      key,
      resolve: deferred.resolve,
      reject: deferred.reject,
      timer: null,
      promise: deferred.promise,
    }
    pending.timer = setTimeout(() => {
      this.#settle(pending, null, actionError(
        'client_action_timeout',
        `Client Action timed out: ${actionName}`,
      ))
    }, Math.max(100, Number(timeoutMs) || this.timeoutMs))
    pending.timer.unref?.()
    this.pendingById.set(requestId, pending)
    if (key) this.pendingByKey.set(key, pending)
    try {
      this.send({
        type: GatewayClientProtocolEvent.CLIENT_ACTION_REQUEST,
        event_id: requestId,
        name: actionName,
        arguments: argumentsValue,
      })
    } catch (error) {
      this.#settle(pending, null, error)
    }
    return pending.promise
  }

  receive(value) {
    const result = GatewayClientActionResultSchema.parse(value)
    const pending = this.pendingById.get(result.request_event_id)
    if (!pending) return false
    if (result.status === 'completed') {
      this.#settle(pending, result)
      return true
    }
    this.#settle(pending, null, actionError(
      result.error?.code || `client_action_${result.status}`,
      result.error?.message || `Client Action ${result.status}: ${pending.name}`,
      { result },
    ))
    return true
  }

  close(reason = 'Client disconnected') {
    const error = actionError('client_action_disconnected', reason)
    for (const pending of [...this.pendingById.values()]) {
      this.#settle(pending, null, error)
    }
  }

  #settle(pending, result, error = null) {
    if (this.pendingById.get(pending.requestId) !== pending) return
    clearTimeout(pending.timer)
    this.pendingById.delete(pending.requestId)
    if (pending.key && this.pendingByKey.get(pending.key) === pending) {
      this.pendingByKey.delete(pending.key)
    }
    if (error) pending.reject(error)
    else pending.resolve(result)
  }
}
