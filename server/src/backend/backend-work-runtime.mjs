import { assertBackendPort } from './backend-port.mjs'
import { backendInstructionFromWork } from './backend-work-input.mjs'

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
    const work = {
      id: workId,
      jobId,
      ownerId: clean(options.ownerId),
      instruction: input?.instruction,
      originalRequest: input?.originalRequest,
      objective: input?.objective,
      timeZone: input?.timeZone,
      workingDirectory: input?.workingDirectory,
      inputParts: input?.inputParts || [],
    }
    work.instruction = backendInstructionFromWork(work)
    return this.backend.submit(work, {
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
