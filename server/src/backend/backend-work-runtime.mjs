import { assertBackendPort } from './backend-port.mjs'
import { backendInstructionFromWork } from './backend-work-input.mjs'

function clean(value) {
  return String(value || '').trim()
}

/**
 * Protocol-neutral application facade for one configured backend.
 *
 * It translates the Gateway's accepted Task context into BackendPort calls.
 * Prompt formats, Session routing, and delegation topology belong to adapters.
 */
export class BackendWorkRuntime {
  constructor({ backend } = {}) {
    this.backend = assertBackendPort(backend, {
      name: 'BackendWorkRuntime backend',
    })
  }

  run(input, options = {}) {
    const taskId = clean(options.taskId)
    const work = {
      id: taskId,
      ownerId: clean(options.ownerId),
      instruction: input?.instruction,
      objective: input?.objective,
      inputParts: input?.inputParts || [],
    }
    work.instruction = backendInstructionFromWork(work)
    return this.backend.submit(work, {
      signal: options.signal,
      onEvent: options.onEvent,
    })
  }

  cancel(taskId, options = {}) {
    return this.backend.cancel(taskId, options)
  }

  status(taskId, options = {}) {
    return this.backend.status(taskId, options)
  }

  respondInput(taskId, inputRequestId, response, options = {}) {
    return this.backend.respondInput(
      taskId,
      inputRequestId,
      response,
      options,
    )
  }
}
