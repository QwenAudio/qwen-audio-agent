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
      ...(input?.resumeContext ? { resumeContext: input.resumeContext } : {}),
      ...(options.continuity !== 'isolated' && input?.conversation
        ? { conversation: input.conversation } : {}),
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
   * coordinator context. Adapters must also bypass any optional conversation
   * continuity (for example, ACP Sessions or reusable A2A contexts).
   */
  runIsolated(input, options = {}) {
    return this.run(input, { ...options, continuity: 'isolated' })
  }

  cancel(taskId, options = {}) {
    return this.backend.cancel(taskId, options)
  }

  canUpdate() {
    return this.backend.describe()?.capabilities?.workUpdates === true
      && typeof this.backend.update === 'function'
  }

  update(taskId, input, options = {}) {
    if (!this.canUpdate()) {
      throw Object.assign(new Error('当前后台不支持调整已有工作。'), { code: 'update_unsupported' })
    }
    const receipt = this.backend.update(taskId, input, options)
    if (typeof receipt?.completion?.then !== 'function') {
      // A misconfigured async adapter may already have dispatched; don't retry.
      receipt?.catch?.(() => {})
      throw Object.assign(new Error('后台未返回有效的调整回执，投递结果无法确认；没有自动重发。'), {
        code: 'update_unconfirmed',
      })
    }
    return receipt
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
