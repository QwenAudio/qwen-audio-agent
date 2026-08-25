export const BACKEND_ADAPTER_SDK_VERSION = '1.0.0'

export {
  assertBackendPort,
  BACKEND_PORT_METHODS,
  BackendPortContractError,
} from './backend-port.mjs'
export { BackendWorkRuntime } from './backend-work-runtime.mjs'
export {
  verifyBackendAdapterConformance,
} from './backend-adapter-conformance.mjs'

import { assertBackendPort } from './backend-port.mjs'

/**
 * Define and validate one protocol-neutral backend adapter at composition time.
 */
export function defineBackendAdapter(adapter, { name = 'Backend adapter' } = {}) {
  return assertBackendPort(adapter, { name })
}

/**
 * Add the small application-host surface used by createGatewayApplication.
 * Backend execution still goes exclusively through BackendPort methods.
 */
export function createBackendAgentHost(adapter, options = {}) {
  const backend = defineBackendAdapter(adapter, options)
  const initial = backend.describe()
  return {
    enabled: initial.enabled !== false && initial.configured !== false,
    protocol: initial.protocol || initial.kind || 'custom',
    label: initial.label || 'Custom backend',
    describe: () => backend.describe(),
    health: () => backend.health(),
    status: (workId, context) => backend.status(workId, context),
    start: context => backend.start(context),
    submit: (work, context) => backend.submit(work, context),
    cancel: (workId, context) => backend.cancel(workId, context),
    respondAuthorization: (workId, authorizationId, decision, context) => (
      backend.respondAuthorization(workId, authorizationId, decision, context)
    ),
    subscribe: listener => backend.subscribe(listener),
    canRecoverDelegatedWork: task => (
      backend.canRecoverDelegatedWork?.(task) === true
    ),
    recoverDelegatedWork: (task, context) => {
      if (typeof backend.recoverDelegatedWork !== 'function') {
        throw new Error('Custom backend does not support delegated Work recovery')
      }
      return backend.recoverDelegatedWork(task, context)
    },
    uiUrl: context => backend.uiUrl?.(context) || Promise.resolve(null),
    close: () => backend.close(),
  }
}
