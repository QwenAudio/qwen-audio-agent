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
      ...(options.continuity === 'isolated' ? { continuity: 'isolated' } : {}),
    }
    work.instruction = backendInstructionFromWork(work)
    return this.backend.submit(work, {
      signal: options.signal,
      onEvent: options.onEvent,
    })
  }

  /**
   * Run system-owned utility work without placing it in the user's persistent
   * coordinator context. ACP adapters open a fresh Session; task-oriented
   * adapters such as A2A already provide isolation per submission.
   */
  runIsolated(input, options = {}) {
    return this.run(input, { ...options, continuity: 'isolated' })
  }

  supportsQuickLookup() {
    return this.backend.describe?.()?.capabilities?.quickQuery === true
      && typeof this.backend.quickLookup === 'function'
  }

  quickLookup(input, options = {}) {
    if (!this.supportsQuickLookup()) {
      const error = new Error('当前后台 Agent 不支持快速查询')
      error.code = 'quick_query_unsupported'
      return Promise.reject(error)
    }
    return this.backend.quickLookup({
      question: input?.question ?? input?.objective ?? input?.query,
    }, {
      ownerId: clean(options.ownerId),
      sessionId: clean(options.sessionId),
      turnId: clean(options.turnId),
      requestId: clean(options.requestId),
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
