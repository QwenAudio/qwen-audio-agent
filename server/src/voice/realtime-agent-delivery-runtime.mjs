import {
  AgentDeliveryMode,
  createAgentDelivery,
} from '../delivery/agent-delivery.mjs'

/**
 * Projects provider-neutral AgentDelivery values into one Realtime frontend.
 * Blocking remains Gateway policy; provider dialects never escape this class.
 */
export class RealtimeAgentDeliveryRuntime {
  constructor({
    getFrontend,
    isDeliveryBlocked = () => false,
  } = {}) {
    this.getFrontend = getFrontend
    this.isDeliveryBlocked = isDeliveryBlocked
  }

  async deliver(value, { shouldDeliver, injectContext = true } = {}) {
    const delivery = createAgentDelivery(value)
    if (delivery.mode === AgentDeliveryMode.HANDLE) {
      return { completed: true, handled: true, mode: delivery.mode }
    }
    if (this.isDeliveryBlocked()) {
      return { completed: false, blocked: true, mode: delivery.mode }
    }
    const frontend = this.getFrontend?.()
    const inject = typeof frontend?.injectDelivery === 'function'
      ? frontend.injectDelivery.bind(frontend)
      : delivery.mode === AgentDeliveryMode.RESPOND
        && typeof frontend?.injectResult === 'function'
        ? (text, origin, context, options) => frontend.injectResult(
            text,
            origin,
            context,
            {
              injectContext: options.injectContext,
              instructions: options.instructions,
            },
          )
        : null
    // Older code-level embedders did not expose an explicit ready flag. Keep
    // that interface working while requiring a concrete injection primitive.
    if (frontend?.ready === false || !inject) {
      return { completed: false, unavailable: true, mode: delivery.mode }
    }
    return inject(
      delivery.text,
      delivery.origin,
      delivery.correlation,
      {
        route: delivery.mode,
        injectContext,
        instructions: delivery.presentation?.instructions || '',
        allowTools: delivery.presentation?.allowTools === true,
        contextTiming: delivery.presentation?.contextTiming || 'response',
        shouldRespond: shouldDeliver,
      },
    )
  }
}
