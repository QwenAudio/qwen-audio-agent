// User-facing authorization scopes. BackendPort still receives per-operation
// decisions; task/session grants belong to the Gateway, not to an adapter.
export const PERMISSION_DECISIONS = Object.freeze(['task', 'always', 'reject'])

export function backendPermissionDecision(decision) {
  if (!PERMISSION_DECISIONS.includes(decision)) throw new TypeError('Invalid permission decision')
  return decision === 'reject' ? 'reject' : 'once'
}
