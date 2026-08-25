/**
 * Protocol-neutral boundary between the Gateway and one configured backend.
 *
 * Every adapter exposes the complete method surface. Optional behavior is
 * advertised by describe() and rejected explicitly by the adapter; callers
 * never infer support from a missing method.
 *
 * Method contract:
 *   describe() -> stable identity and capabilities
 *   start(context?) -> idempotently make the backend ready
 *   health() -> current backend availability
 *   submit(work, context?) -> run one Work and return its final outcome
 *   status(workId, context?) -> current adapter-owned Work status
 *   cancel(workId, context?) -> cancel one adapter-owned Work
 *   respondAuthorization(workId, authorizationId, decision, context?)
 *   subscribe(listener) -> unsubscribe function for backend Work events
 *   close() -> idempotently release adapter-owned resources
 */
export const BACKEND_PORT_METHODS = Object.freeze([
  'describe',
  'start',
  'health',
  'submit',
  'status',
  'cancel',
  'respondAuthorization',
  'subscribe',
  'close',
])

export class BackendPortContractError extends TypeError {
  constructor(message, { missing = [] } = {}) {
    super(message)
    this.name = 'BackendPortContractError'
    this.code = 'INVALID_BACKEND_PORT'
    this.missing = [...missing]
  }
}

export function assertBackendPort(value, { name = 'BackendPort' } = {}) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
    throw new BackendPortContractError(`${name} must be an object`, {
      missing: BACKEND_PORT_METHODS,
    })
  }
  const missing = BACKEND_PORT_METHODS.filter(
    method => typeof value[method] !== 'function',
  )
  if (missing.length) {
    throw new BackendPortContractError(
      `${name} is missing required methods: ${missing.join(', ')}`,
      { missing },
    )
  }
  return value
}
