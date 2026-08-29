/**
 * Protocol-neutral events emitted by BackendPort adapters.
 *
 * ACP session updates, A2A task events, and custom backend callbacks are
 * normalized here before entering TaskManager. Protocol payloads must not
 * escape their adapter.
 */
export const BackendEventType = Object.freeze({
  ACTIVITY: 'backend.activity',
  MESSAGE: 'backend.message',
  ARTIFACT: 'backend.artifact',
  AUTHORIZATION_REQUESTED: 'backend.permission.requested',
  AUTHORIZATION_RESOLVED: 'backend.permission.resolved',
  INPUT_REQUESTED: 'backend.input.requested',
  INPUT_RESOLVED: 'backend.input.resolved',
  DELEGATED: 'backend.delegated',
  DELEGATION_COMPLETED: 'backend.delegation.completed',
})

export const BACKEND_EVENT_TYPES = new Set(Object.values(BackendEventType))

export function backendEvent(type, details = {}) {
  if (!BACKEND_EVENT_TYPES.has(type)) {
    throw new TypeError(`Unknown BackendPort event: ${type}`)
  }
  return { type, ...details }
}
