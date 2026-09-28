import { backendPermissionDecision, PERMISSION_DECISIONS } from '../../../shared/permission-decisions.mjs'
import { BackendEventType } from '../core/backend-events.mjs'

export class TaskOperationError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'TaskOperationError'
    this.code = code
  }
}

function owner(context) {
  const ownerId = String(context?.ownerId || '').trim()
  if (!ownerId) throw new TaskOperationError('unauthorized', 'task owner is required')
  return ownerId
}

function permissionReceipt(admission, permissionId) {
  return {
    taskId: admission.taskId,
    permissionId,
    permissionIds: admission.permissionIds,
    decision: admission.decision,
    acknowledged: admission.responses.get(permissionId),
    completion: admission.completion,
  }
}

/**
 * Transport-neutral user Task operations. TaskManager remains the state owner;
 * this service assembles execution and permission policy, never model receipts
 * or public protocol events. System jobs keep their own execution entry point.
 */
export class TaskOperations {
  constructor({ taskManager, backendRuntime, permissionPolicy, respondAuthorization, respondInput } = {}) {
    if (!taskManager) throw new TypeError('taskManager is required')
    this.taskManager = taskManager
    this.backendRuntime = backendRuntime
    this.permissionPolicy = permissionPolicy
    this.respondAuthorization = respondAuthorization
    this.respondInput = respondInput
    // A backend can request several permissions before any is answered. The
    // Task snapshot projects the latest one; retain the live requests as well.
    this.permissions = new Map()
    this.decisions = new Map()
  }

  get(taskId, context) {
    return this.taskManager.get(String(taskId || '').trim(), { ownerId: owner(context) })
  }

  list(context, filters = {}) {
    const { sessionId, active } = context
    return this.taskManager.list({ sessionId, active, ...filters, ownerId: owner(context) })
  }

  submit({ objective, inputParts = [], submissionKey }, context) {
    const ownerId = owner(context)
    const { sessionId = 'main', turnId } = context
    return this.taskManager.create({
      objective, ownerId, sessionId, turnId, submissionKey,
      laneKey: `backend:${ownerId}`,
      laneLimit: 1,
      runner: (_objective, execution) => this.run({ objective, inputParts }, {
        ...execution, ownerId, sessionId, turnId,
      }),
      canceler: async ({ task, previousStatus, abort }) => {
        const result = await this.backendRuntime.cancel(task.id, { ownerId })
        abort()
        return {
          ...result,
          layer: previousStatus === 'finalizing' ? 'finalizing' : result?.layer || 'backend',
        }
      },
    })
  }

  async run(input, context) {
    const ownerId = owner(context)
    try {
      return await this.backendRuntime.run(input, {
        ...context, ownerId,
        onEvent: event => this.forwardBackendEvent(context, event, context.onEvent),
      })
    } finally {
      this.clearPermissions(context.taskId, ownerId)
    }
  }

  runScheduled(objective, context) {
    return this.run({ objective }, context)
  }

  forwardBackendEvent(context, event, onEvent) {
    const ownerId = owner(context)
    const publish = event => {
      const id = event?.permission?.id
      if (id && event.type === BackendEventType.AUTHORIZATION_RESOLVED) this.permissions.delete(id)
      if (id && event.type === BackendEventType.AUTHORIZATION_REQUESTED) {
        this.permissions.set(id, {
          ownerId, taskId: context.taskId, permission: event.permission,
        })
      }
      onEvent(event)
    }
    if (this.permissionPolicy) {
      this.permissionPolicy.forwardBackendEvent(context, event, publish, this.respondAuthorization)
    } else {
      publish(event)
    }
  }

  cancel(taskId, context) {
    const ownerId = owner(context)
    return this.taskManager.cancel(taskId, { ownerId }).finally(() => {
      this.clearPermissions(taskId, ownerId)
    })
  }

  clearPermissions(taskId, ownerId) {
    for (const [id, entry] of this.permissions) {
      if (entry.taskId === taskId && entry.ownerId === ownerId) this.permissions.delete(id)
    }
    for (const [id, entry] of this.decisions) {
      if (entry.taskId === taskId && entry.ownerId === ownerId) this.decisions.delete(id)
    }
  }

  cancelSeries(seriesId, context) {
    const ownerId = owner(context)
    return this.taskManager.cancelSeries(seriesId, { ownerId }).then(tasks => {
      for (const task of tasks) this.clearPermissions(task.id, ownerId)
      return tasks
    })
  }

  pendingPermissions(context) {
    const ownerId = owner(context)
    const tasks = new Map(this.list(context, {
      sessionId: context.sessionId,
      active: true,
    }).filter(task => task.status !== 'cancelling').map(task => [task.id, task]))
    const pending = new Map()
    for (const [id, entry] of this.permissions) {
      const task = tasks.get(entry.taskId)
      if (entry.ownerId === ownerId && task && entry.permission.status === 'pending') {
        pending.set(id, { task, permission: entry.permission })
      }
    }
    // Reconnection/restoration does not depend on having seen the live event.
    for (const task of tasks.values()) {
      if (task.authorization?.status === 'pending') {
        pending.set(task.authorization.id, { task, permission: task.authorization })
      }
    }
    return pending
  }

  /** Accept locally now; callers choose whether to await backend acknowledgement. */
  submitPermission(permissionId, decision, context, { onFailure = () => {} } = {}) {
    const selected = this.pendingPermissions(context).get(permissionId)
    if (!selected || !this.respondAuthorization) {
      throw new TaskOperationError('permission_not_found', 'permission request not found')
    }
    if (!PERMISSION_DECISIONS.includes(decision)) {
      throw new TaskOperationError('invalid_permission_response', 'invalid permission decision')
    }
    const { task } = selected
    const existing = this.decisions.get(permissionId)
    if (existing) {
      if (existing.decision !== decision) {
        throw new TaskOperationError('permission_already_submitted', 'a different permission decision is already pending')
      }
      existing.failureObservers.add(onFailure)
      return permissionReceipt(existing, permissionId)
    }
    const pending = this.pendingPermissions({ ownerId: task.ownerId, sessionId: task.sessionId })
    const ids = decision === 'reject' ? [permissionId] : [...pending]
      .filter(([id, entry]) => entry.task.id === task.id && !this.decisions.has(id))
      .map(([id]) => id)
    const rollback = this.permissionPolicy?.applyDecision(task.ownerId, task.sessionId, decision, task.id)
    const admission = { ownerId: task.ownerId, taskId: task.id, permissionId, permissionIds: ids, decision }
    admission.failureObservers = new Set([onFailure])
    ids.forEach(id => this.decisions.set(id, admission))
    admission.responses = new Map(ids.map(id => [id, Promise.resolve().then(async () => {
      try {
        const result = await this.respondAuthorization(task.id, id, backendPermissionDecision(decision), {
          ownerId: task.ownerId,
        })
        this.permissionPolicy?.settle(id)
        return result
      } catch (error) {
        for (const observer of admission.failureObservers) {
          try { observer({ permissionId: id, taskId: task.id, decision, error }) } catch { /* diagnostics only */ }
        }
        throw error
      } finally {
        if (this.decisions.get(id) === admission) this.decisions.delete(id)
      }
    })]))
    admission.completion = Promise.all(admission.responses.values()).then(() => {
      this.permissionPolicy?.flushPending(task.ownerId, task.sessionId)
    }).catch(error => {
      rollback?.()
      throw error
    })
    // Cards await their own request, not another concurrent backend approval.
    // The batch still drains (and rolls back on failure) after that card reply.
    admission.completion.catch(() => {})
    return permissionReceipt(admission, permissionId)
  }

  respondToInput(taskId, inputRequestId, response, context) {
    const task = this.get(taskId, context)
    if (!this.respondInput || !task || task.status === 'cancelling'
      || (context.sessionId && task.sessionId !== context.sessionId)
      || task.inputRequest?.id !== inputRequestId || task.inputRequest.status !== 'pending') {
      throw new TaskOperationError('input_not_found', 'input request not found')
    }
    return this.respondInput(task.id, inputRequestId, response, { ownerId: owner(context) })
  }
}
