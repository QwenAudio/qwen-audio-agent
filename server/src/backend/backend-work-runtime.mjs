import { assertBackendPort } from './backend-port.mjs'

function clean(value) {
  return String(value || '').trim()
}

/**
 * Protocol-neutral application facade for one configured backend.
 *
 * It translates the Gateway's accepted Work context into BackendPort calls.
 * Prompt formats, Session routing, and delegation topology belong to adapters.
 */
export class BackendWorkRuntime {
  constructor({ backend } = {}) {
    this.backend = assertBackendPort(backend, {
      name: 'BackendWorkRuntime backend',
    })
  }

  run(input, options = {}) {
    const workId = clean(options.workId)
    const jobId = clean(options.jobId) || workId
    return this.backend.submit({
      id: workId,
      jobId,
      ownerId: clean(options.ownerId),
      originalRequest: input?.originalRequest,
      objective: input?.objective,
      conversationContext: input?.conversationContext || [],
      userMemories: input?.userMemories || [],
      timeZone: input?.timeZone,
      workingDirectory: input?.workingDirectory,
      inputParts: input?.inputParts || [],
    }, {
      signal: options.signal,
      onEvent: options.onEvent,
    })
  }

  cancel(workId, options = {}) {
    return this.backend.cancel(workId, options)
  }

  status(workId, options = {}) {
    return this.backend.status(workId, options)
  }
}
