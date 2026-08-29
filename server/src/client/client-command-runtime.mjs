import { GatewayClientProtocolEvent } from '../../../shared/gateway-client-protocol.mjs'
import { normalizeInputParts } from '../../../shared/input-parts.mjs'
import { isTaskCancellable } from '../task/task-state.mjs'

function clean(value) {
  return String(value || '').trim()
}

function objectiveFromMessage(message = {}) {
  const parts = Array.isArray(message.parts) ? message.parts : []
  const text = parts
    .filter(part => part?.type === 'text')
    .map(part => clean(part.text))
    .filter(Boolean)
    .join('\n')
  if (text) return text
  const files = parts
    .filter(part => part?.type === 'file')
    .map((part, index) => clean(part.filename) || `附件 ${index + 1}`)
    .filter(Boolean)
  return files.length ? `处理客户端提交的文件：${files.join('、')}` : ''
}

function inputPartsFromMessage(message = {}) {
  return (Array.isArray(message.parts) ? message.parts : [])
    .filter(part => part?.type === 'file')
    .map(part => ({ ...part }))
}

export class RuntimeCommandError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'RuntimeCommandError'
    this.code = code
  }
}

export class GatewayClientCommandRuntime {
  constructor({
    taskManager,
    backendRuntime,
    conversationHistory,
    respondAuthorization,
    respondInput,
    permissionPolicy,
    logger = null,
  } = {}) {
    if (!taskManager) throw new TypeError('taskManager is required')
    if (!backendRuntime) throw new TypeError('backendRuntime is required')
    if (!conversationHistory) throw new TypeError('conversationHistory is required')
    this.taskManager = taskManager
    this.backendRuntime = backendRuntime
    this.conversationHistory = conversationHistory
    this.respondAuthorization = respondAuthorization
    this.respondInput = respondInput
    this.permissionPolicy = permissionPolicy
    this.logger = logger
  }

  async execute(message, context = {}) {
    const requestEventId = clean(message?.event_id)
    const common = { request_event_id: requestEventId }
    switch (message?.type) {
      case GatewayClientProtocolEvent.TASK_CREATE:
        return {
          type: GatewayClientProtocolEvent.TASK_CREATE_RESULT,
          ...common,
          task: this.createTask(message, context),
        }
      case GatewayClientProtocolEvent.TASK_GET:
        return {
          type: GatewayClientProtocolEvent.TASK_GET_RESULT,
          ...common,
          task: this.getTask(message.task_id, context),
        }
      case GatewayClientProtocolEvent.TASK_LIST:
        return {
          type: GatewayClientProtocolEvent.TASK_LIST_RESULT,
          ...common,
          tasks: this.listTasks(message, context),
        }
      case GatewayClientProtocolEvent.TASK_CANCEL:
        return {
          type: GatewayClientProtocolEvent.TASK_CANCEL_RESULT,
          ...common,
          task: await this.cancelTask(message.task_id, context, { wait: false }),
        }
      case GatewayClientProtocolEvent.PERMISSION_RESPOND:
        return {
          type: GatewayClientProtocolEvent.PERMISSION_RESPOND_RESULT,
          ...common,
          permission: await this.respondPermission(message, context),
        }
      case GatewayClientProtocolEvent.INPUT_RESPOND:
        return {
          type: GatewayClientProtocolEvent.INPUT_RESPOND_RESULT,
          ...common,
          input: await this.respondToInput(message, context),
        }
      case GatewayClientProtocolEvent.CONVERSATION_HISTORY:
        return {
          type: GatewayClientProtocolEvent.CONVERSATION_HISTORY_RESULT,
          ...common,
          messages: await this.history(message, context),
        }
      default:
        throw new RuntimeCommandError(
          'unknown_type',
          `unsupported runtime command: ${clean(message?.type)}`,
        )
    }
  }

  createTask(message, { ownerId, sessionId = 'main' } = {}) {
    let normalizedMessage
    try {
      normalizedMessage = {
        parts: normalizeInputParts(message.message?.parts),
      }
    } catch (error) {
      throw new RuntimeCommandError('bad_event', error.message)
    }
    const objective = objectiveFromMessage(normalizedMessage)
    if (!objective) {
      throw new RuntimeCommandError('bad_event', 'task.create requires content')
    }
    const inputParts = inputPartsFromMessage(normalizedMessage)
    let taskId = ''
    const task = this.taskManager.create({
      objective,
      ownerId,
      sessionId,
      submissionKey: clean(message.event_id),
      laneKey: `backend:${clean(ownerId)}`,
      laneLimit: 1,
      runner: async (_ignored, { onEvent, signal }) => this.backendRuntime.run({
        objective,
        inputParts,
      }, {
        ownerId,
        sessionId,
        taskId,
        signal,
        onEvent,
      }),
      canceler: async ({ abort }) => {
        const result = await this.backendRuntime.cancel(taskId, { ownerId })
        abort()
        return result
      },
    })
    taskId = task.id
    const publicTask = { ...task }
    delete publicTask.reused
    return publicTask
  }

  getTask(taskId, { ownerId } = {}) {
    const task = this.taskManager.get(clean(taskId), { ownerId })
    if (!task) throw new RuntimeCommandError('task_not_found', 'task not found')
    return task
  }

  listTasks(message = {}, { ownerId, sessionId = 'main', allSessions = false } = {}) {
    const limit = Number(message.limit) || 50
    return this.taskManager.list({
      ownerId,
      sessionId: message.session_id || (allSessions ? undefined : sessionId),
      active: message.active === true,
    }).slice(0, limit)
  }

  async cancelTask(taskId, { ownerId } = {}, { wait = false } = {}) {
    const id = clean(taskId)
    const existing = this.getTask(id, { ownerId })
    if (!isTaskCancellable(existing.status) && existing.status !== 'cancelling') {
      throw new RuntimeCommandError('task_not_cancellable', 'task is no longer active')
    }
    const pending = this.taskManager.cancel(id, { ownerId })
    if (wait) return pending
    pending.catch(error => {
      this.logger?.warn('task.cancel_async_failed', { taskId: id, error })
    })
    return this.taskManager.get(id, { ownerId }) || existing
  }

  async respondPermission(message, { ownerId } = {}) {
    if (!this.respondAuthorization) {
      throw new RuntimeCommandError('permission_not_found', 'permission runtime unavailable')
    }
    const permissionId = clean(message.permission_id)
    const permissionTask = this.taskManager.list({
      ownerId,
      active: true,
    }).find(task => task.authorization?.id === permissionId)
    if (!permissionTask) {
      throw new RuntimeCommandError('permission_not_found', 'permission request not found')
    }
    const previousPermissionMode = this.permissionPolicy?.mode(
      ownerId,
      permissionTask.sessionId,
    )
    this.permissionPolicy?.applyDecision(
      ownerId,
      permissionTask.sessionId,
      message.decision,
    )
    try {
      return await this.respondAuthorization(
        permissionTask.id,
        permissionId,
        message.decision,
        { ownerId },
      )
    } catch (error) {
      if (previousPermissionMode) {
        this.permissionPolicy?.setMode(
          ownerId,
          permissionTask.sessionId,
          previousPermissionMode,
        )
      }
      throw error
    }
  }

  async respondToInput(message, { ownerId } = {}) {
    if (!this.respondInput) {
      throw new RuntimeCommandError('input_not_found', 'input runtime unavailable')
    }
    const task = this.taskManager.get(clean(message.task_id), { ownerId })
    if (
      !task
      || task.inputRequest?.id !== clean(message.input_request_id)
      || task.inputRequest.status !== 'pending'
    ) {
      throw new RuntimeCommandError('input_not_found', 'input request not found')
    }
    return this.respondInput(task.id, task.inputRequest.id, {
      action: message.action,
      text: message.text,
      values: message.values,
    }, { ownerId })
  }

  history(message = {}, { ownerId, sessionId = 'main' } = {}) {
    return this.conversationHistory.messages({
      ownerId,
      sessionId: message.session_id || sessionId,
    })
  }
}
