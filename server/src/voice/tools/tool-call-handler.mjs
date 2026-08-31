import { createHash } from 'node:crypto'
import { permissionReference } from './permission-reference.mjs'
import {
  PERMISSION_RESPONSE_CAPABILITY,
  BACKEND_INPUT_RESPONSE_CAPABILITY,
  CANCEL_AGENT_TASK_TOOL_NAME,
  SCHEDULE_REMINDER_TOOL_NAME,
  SPAWN_THINKING_TOOL_NAME,
  GET_AGENT_TASK_STATUS_TOOL_NAME,
  GET_CURRENT_TIME_TOOL_NAME,
  ENTER_SLEEP_TOOL_NAME,
  NOTES_TOOL_NAME,
  MEMORY_TOOL_NAME,
  RESPOND_PERMISSION_TOOL_NAME,
  RESPOND_AGENT_INPUT_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  FETCH_URL_TOOL_NAME,
  KNOWLEDGE_TOOL_NAME,
  frontendToolRegistry,
  RECALL_TOOL_NAME,
  FRONTEND_RECALL_CAPABILITY,
} from '../frontend-tools.mjs'
import {
  findFrontendSourceTool,
} from '../../frontend/tools/frontend-tool-source.mjs'
import {
  boundFrontendToolResult,
  FrontendToolLoop,
} from './frontend-tool-loop.mjs'
import { currentTimeSnapshot } from '../../conversation/frontend-agent-context.mjs'
import { describeWhen } from '../../conversation/session-digest.mjs'
import { canonicalScope, isMemoryDocument } from '../../core/memory-scopes.mjs'
import { inputPartRef } from '../../../../shared/input-parts.mjs'
import { BackendEventType } from '../../core/backend-events.mjs'

const SENSITIVE_MEMORY = /(?:pass(?:word)?|secret|api[_ -]?key|access[_ -]?token|credential|验证码|密码|密钥|令牌|\bsk-[a-z0-9_-]+)/i

const CANCEL_RECEIPT_INSTRUCTIONS = [
  '根据本次响应中的全部取消结果，只作一次简短自然的确认。',
  '不要逐项复述 task_id，不要再次查询或取消，不要调用其他工具。',
].join(' ')

const STATUS_RESULT_MESSAGE = '请根据这次查询结果自然回答用户；不要再次调用状态工具，不要展示 task_id。'
function objectiveFingerprint(objective) {
  return createHash('sha256')
    .update(String(objective || '').replace(/\s+/g, ' ').trim())
    .digest('hex')
    .slice(0, 24)
}

function recentTaskUpdates(activity = [], limit = 5) {
  const updates = []
  for (const item of activity) {
    if (!item || item.kind === 'text') continue
    const detail = String(
      item.detail || item.label || item.tool || '',
    ).replace(/\s+/g, ' ').trim().slice(0, 200)
    const update = {
      kind: String(item.kind || 'activity'),
      status: String(item.status || 'running'),
      ...(item.category ? { category: String(item.category) } : {}),
      ...(detail ? { detail } : {}),
      ...(Number.isFinite(item.completed)
        ? { completed: item.completed }
        : {}),
      ...(Number.isFinite(item.total) ? { total: item.total } : {}),
    }
    const previous = updates.at(-1)
    if (previous && JSON.stringify(previous) === JSON.stringify(update)) {
      continue
    }
    updates.push(update)
  }
  return updates.slice(-limit)
}

function mergeInputParts(...groups) {
  const merged = []
  const seen = new Set()
  for (const part of groups.flat()) {
    if (part?.type !== 'file') continue
    const key = inputPartRef(part) || [part.mime, part.url].join('\u0000')
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(part)
  }
  return merged
}

function failure(errorCode, userMessage, {
  retryable = false,
  status = 'failed',
  ...details
} = {}) {
  return {
    status,
    error: true,
    error_code: errorCode,
    user_message: userMessage,
    retryable,
    ...details,
  }
}

export class ToolCallHandler {
  constructor({
    taskManager,
    ownerId,
    sessionId,
    transcripts,
    getFrontend,
    getTurnId,
    getTurnGeneration,
    backendRuntime,
    backendAvailability = null,
    memoryService,
    notesStore,
    getClientContext = () => ({}),
    onMemoryChanged = () => {},
    respondAuthorization,
    respondInput,
    permissionPolicy,
    onPermissionDeliveryFailed = () => {},
    presenceController = null,
    onAgentActivity = () => {},
    inputAssets = null,
    frontendRetrieval = null,
    frontendKnowledge = null,
    frontendToolSources = [],
    turnCitations = null,
    sessionDigests = null,
  }) {
    this.taskManager = taskManager
    this.ownerId = ownerId
    this.sessionId = sessionId
    this.transcripts = transcripts
    this.getFrontend = getFrontend
    this.getTurnId = getTurnId
    this.getTurnGeneration = getTurnGeneration
    this.backendRuntime = backendRuntime
    this.backendAvailability = backendAvailability
    this.memoryService = memoryService
    this.notesStore = notesStore
    this.getClientContext = getClientContext
    this.onMemoryChanged = onMemoryChanged
    this.respondAuthorization = respondAuthorization
    this.respondInput = respondInput
    this.permissionPolicy = permissionPolicy
    this.onPermissionDeliveryFailed = onPermissionDeliveryFailed
    this.presenceController = presenceController
    this.onAgentActivity = onAgentActivity
    this.inputAssets = inputAssets
    this.frontendRetrieval = frontendRetrieval
    this.frontendKnowledge = frontendKnowledge
    this.frontendToolSources = frontendToolSources
    this.turnCitations = turnCitations
    this.activeToolEntries = new Map()
    this.externalToolLoop = new FrontendToolLoop()
    this.toolExecutor = frontendToolRegistry.createExecutor({
      [SPAWN_THINKING_TOOL_NAME]: context => (
        this.executeSpawnThinkingToolCall(context)
      ),
      [SCHEDULE_REMINDER_TOOL_NAME]: ({ callId, turnId, args }) => (
        this.handleScheduleReminder(callId, turnId, args)
      ),
      [CANCEL_AGENT_TASK_TOOL_NAME]: context => (
        this.executeCancelToolCall(context)
      ),
      [GET_AGENT_TASK_STATUS_TOOL_NAME]: context => (
        this.executeStatusToolCall(context)
      ),
      [GET_CURRENT_TIME_TOOL_NAME]: ({ callId, turnId }) => (
        this.getCurrentTime(callId, turnId)
      ),
      [MEMORY_TOOL_NAME]: context => this.executeMemoryToolCall(context),
      [NOTES_TOOL_NAME]: ({ callId, turnId, args }) => (
        this.notes(callId, turnId, args)
      ),
      [RESPOND_PERMISSION_TOOL_NAME]: context => this.respondPermission(context),
      [RESPOND_AGENT_INPUT_TOOL_NAME]: context => (
        this.respondAgentInput(context)
      ),
      [ENTER_SLEEP_TOOL_NAME]: ({ callId, turnId }) => (
        this.enterSleep(callId, turnId)
      ),
      [WEB_SEARCH_TOOL_NAME]: context => this.webSearch(context),
      [FETCH_URL_TOOL_NAME]: context => this.fetchUrl(context),
      [KNOWLEDGE_TOOL_NAME]: context => this.knowledge(context),
      [RECALL_TOOL_NAME]: ({ callId, turnId, args }) => (
        this.recall(callId, turnId, args)
      ),
    })
    this.sessionDigests = sessionDigests
    this.gatewayApprovedPermissions = new Set()
    this.processedCalls = new Set()
    this.spawnResponseByTurn = new Map()
    this.statusResponseByTurn = new Map()
    this.cancelResponseByTurn = new Map()
    this.terminalToolResponses = new Set()
    this.deferredToolResponses = new Map()
    this.pendingBackendPermissions = new Map()
    this.submittedBackendPermissions = new Set()
  }

  externalTool(name) {
    return findFrontendSourceTool(this.frontendToolSources, name)
  }

  hasPendingBackendPermission() {
    if (this.pendingBackendPermissions.size) return true
    if (!this.taskManager?.list) return false
    return this.taskManager.list({
      ownerId: this.ownerId,
      sessionId: this.sessionId,
      active: true,
    }).some(task => task.authorization?.status === 'pending')
  }

  hasPendingBackendInput() {
    if (!this.taskManager?.list) return false
    return this.taskManager.list({
      ownerId: this.ownerId,
      sessionId: this.sessionId,
      active: true,
    }).some(task => task.inputRequest?.status === 'pending')
  }

  async executeExternalSource(external, args) {
    const { source, tool } = external
    let output
    try {
      output = await source.execute(tool.name, args)
    } catch {
      output = failure(
        'external_tool_unavailable',
        '外部工具暂时不可用。',
        { retryable: true },
      )
    }
    const bounded = boundFrontendToolResult(
      output,
      tool.policy?.maxResultBytes,
    )
    return bounded.accepted
      ? bounded.value
      : failure(
          'tool_result_too_large',
          '工具结果过大，无法在当前语音轮次中安全返回。',
          { retryable: true },
        )
  }

  async executeExternalToolCall(external, context) {
    const { tool } = external
    const limit = this.externalToolLoop.admit({ ...context, tool })
    if (!limit.admitted) {
      await this.sendOutput(
        context.callId,
        limit.reason === 'repeated_call'
          ? {
              status: 'duplicate',
              message: '本轮相同操作已经处理，不再重复执行。',
            }
          : failure(
              'tool_loop_limit',
              '本轮工具调用已达到安全边界，已停止继续执行。',
              { retryable: true },
            ),
        context.turnId,
      )
      return { handled: true, executed: false, limit }
    }
    const output = await this.executeExternalSource(external, context.args)
    await this.sendOutput(context.callId, output, context.turnId)
    return { handled: true, executed: true, value: output }
  }

  async respondPermission(context) {
    const permissionId = String(context.args?.permission_id || '').trim()
    const backendPermissionPending = [...this.pendingBackendPermissions.keys()]
      .some(id => permissionReference(id) === permissionId)
      || this.taskManager?.list?.({
        ownerId: this.ownerId,
        sessionId: this.sessionId,
        active: true,
      }).some(task => (
        task.authorization?.status === 'pending'
        && permissionReference(task.authorization.id) === permissionId
      ))
    if (backendPermissionPending) return this.respondAgentPermission(context)
    return this.sendOutput(
      context.callId,
      failure('permission_not_pending', '没有找到仍在等待决定的权限请求。'),
      context.turnId,
    )
  }

  markTerminalToolResponse(responseId) {
    const id = String(responseId || '').trim()
    if (!id) return
    if (!this.terminalToolResponses.has(id) && this.terminalToolResponses.size >= 100) {
      this.terminalToolResponses.delete(this.terminalToolResponses.values().next().value)
    }
    this.terminalToolResponses.add(id)
  }

  consumeTerminalToolResponse(responseId) {
    const id = String(responseId || '').trim()
    if (!id || !this.terminalToolResponses.has(id)) return false
    this.terminalToolResponses.delete(id)
    return true
  }

  isStale(turnId, generation) {
    return (
      generation !== this.getTurnGeneration()
      || Boolean(turnId && this.getTurnId() && turnId !== this.getTurnId())
    )
  }

  async sendOutput(callId, output, turnId, taskId, options) {
    const {
      responseContext,
      ...frontendOptions
    } = options || {}
    const tool = this.activeToolEntries.get(callId)
    const bounded = boundFrontendToolResult(
      output,
      tool?.policy.maxResultBytes,
    )
    const safeOutput = bounded.accepted
      ? bounded.value
      : failure(
          'tool_result_too_large',
          '工具结果过大，无法在当前语音轮次中安全返回。',
          { retryable: true },
        )
    const projectedOutput = this.turnCitations?.project(turnId, safeOutput)
      || safeOutput
    await this.getFrontend()?.sendFunctionOutput(
      callId,
      projectedOutput,
      { turnId, taskId, ...(responseContext || {}) },
      frontendOptions,
    )
    return projectedOutput
  }

  beginDeferredToolResponse(responseId, {
    turnId,
    turnGeneration,
  } = {}, response = null) {
    const key = String(responseId || '')
    if (!key) return null
    const batch = this.deferredToolResponses.get(key) || {
      pending: 0,
      sourceDone: false,
      failed: false,
      suppressResponse: false,
      turnId,
      turnGeneration,
      responseInstructions: [],
    }
    if (!this.deferredToolResponses.has(key) && this.deferredToolResponses.size >= 100) {
      this.deferredToolResponses.delete(this.deferredToolResponses.keys().next().value)
    }
    batch.pending += 1
    const instructions = String(response?.instructions || '').trim()
    if (instructions && !batch.responseInstructions.includes(instructions)) {
      batch.responseInstructions.push(instructions)
    }
    this.deferredToolResponses.set(key, batch)
    return key
  }

  addDeferredToolResponseInstructions(responseId, instructions) {
    const batch = this.deferredToolResponses.get(String(responseId || ''))
    const value = String(instructions || '').trim()
    if (!batch || !value || batch.responseInstructions.includes(value)) return
    batch.responseInstructions.push(value)
  }

  async completeDeferredToolResponse(responseId, { failed = false } = {}) {
    const batch = this.deferredToolResponses.get(responseId)
    if (!batch) return
    batch.pending = Math.max(0, batch.pending - 1)
    batch.failed ||= failed
    await this.flushDeferredToolResponse(responseId, batch)
  }

  async finishToolResponse(responseId, { suppressResponse = false } = {}) {
    const key = String(responseId || '')
    const batch = this.deferredToolResponses.get(key)
    if (!batch) return
    batch.sourceDone = true
    batch.suppressResponse ||= suppressResponse
    await this.flushDeferredToolResponse(key, batch)
  }

  async flushDeferredToolResponse(responseId, batch) {
    if (!batch.sourceDone || batch.pending > 0) return
    this.deferredToolResponses.delete(responseId)
    if (batch.failed || batch.suppressResponse) return
    await this.getFrontend()?.ensureResponse?.(
      {
        turnId: batch.turnId,
        turnGeneration: batch.turnGeneration,
      },
      batch.responseInstructions.length
        ? {
            response: {
              instructions: batch.responseInstructions.join(' '),
            },
          }
        : undefined,
    )
  }

  async closeStaleCall(callId, turnId) {
    await this.sendOutput(
      callId,
      {
        status: 'superseded',
        message: '用户已经开始了新一轮，这次尚未提交。',
      },
      turnId,
      null,
      { createResponse: false },
    )
  }

  forwardBackendEvent(taskId, event, onEvent) {
    const permission = event?.permission
    if (
      event?.type === BackendEventType.AUTHORIZATION_RESOLVED
      && permission?.id
    ) {
      this.pendingBackendPermissions.delete(permission.id)
      this.submittedBackendPermissions.delete(permission.id)
    }
    if (
      event?.type === BackendEventType.AUTHORIZATION_RESOLVED
      && permission?.id
      && this.gatewayApprovedPermissions.delete(permission.id)
    ) return
    if (
      event?.type !== BackendEventType.AUTHORIZATION_REQUESTED
      || !permission?.id
      || !this.respondAuthorization
      || !this.permissionPolicy?.shouldAutoAllow(
        this.ownerId,
        this.sessionId,
      )
    ) {
      if (
        event?.type === BackendEventType.AUTHORIZATION_REQUESTED
        && permission?.id
      ) {
        this.pendingBackendPermissions.set(permission.id, {
          taskId,
          permission,
        })
      }
      onEvent(event)
      return
    }
    this.gatewayApprovedPermissions.add(permission.id)
    let approval
    try {
      approval = this.respondAuthorization(
        taskId,
        permission.id,
        'always',
        { ownerId: this.ownerId },
      )
    } catch {
      this.gatewayApprovedPermissions.delete(permission.id)
      onEvent(event)
      return
    }
    Promise.resolve(approval)
      .then(() => this.gatewayApprovedPermissions.delete(permission.id))
      .catch(() => {
        if (this.gatewayApprovedPermissions.delete(permission.id)) {
          onEvent(event)
        }
      })
  }

  createWork({
    turnId,
    objective,
    submissionKey,
    inputParts = [],
  }) {
    let taskId = ''
    const task = this.taskManager.create({
      objective,
      ownerId: this.ownerId,
      sessionId: this.sessionId,
      turnId,
      submissionKey,
      laneKey: `backend:${this.ownerId}`,
      laneLimit: 1,
      runner: async (_ignored, { onEvent, signal }) => {
        try {
          return await this.backendRuntime.run({
            objective,
            inputParts,
          }, {
            ownerId: this.ownerId,
            sessionId: this.sessionId,
            turnId,
            taskId,
            signal,
            onEvent: event => this.forwardBackendEvent(taskId, event, onEvent),
          })
        } finally {
          for (const [id, entry] of this.pendingBackendPermissions) {
            if (entry.taskId !== taskId) continue
            this.pendingBackendPermissions.delete(id)
            this.submittedBackendPermissions.delete(id)
          }
        }
      },
      canceler: async ({ previousStatus, abort }) => {
        const result = await this.backendRuntime.cancel(
          taskId,
          { ownerId: this.ownerId },
        )
        abort()
        return {
          ...result,
          layer: previousStatus === 'finalizing'
            ? 'finalizing'
            : result?.layer || 'backend',
        }
      },
    })
    taskId = task.id
    return task
  }

  async handleScheduleReminder(callId, turnId, args) {
    const executeAt = Date.parse(args.execute_at)
    if (!executeAt || executeAt <= Date.now()) {
      await this.sendOutput(callId, {
        status: 'error',
        error: true,
        error_code: 'invalid_time',
        user_message: '触发时间无效或已过期，请提供一个未来的时间。',
      }, turnId)
      return
    }

    const type = args.type === 'task' ? 'task' : 'reminder'
    const recurrence = args.recurrence || 'once'

    // Scheduled work resolves through the same single-backend runtime as a
    // live request. The runtime and owner identity outlive the voice session.
    const backendRuntime = this.backendRuntime
    const runner = type === 'task'
      ? async (objective, context) => backendRuntime.run({
          objective,
        }, {
          ownerId: context.ownerId,
          sessionId: context.sessionId,
          turnId: context.turnId,
          taskId: context.taskId,
          signal: context.signal,
          onEvent: context.onEvent,
        })
      : null

    const task = this.taskManager.createScheduled({
      objective: args.reminder,
      ownerId: this.ownerId,
      sessionId: this.sessionId,
      turnId,
      schedule: { at: executeAt, recurrence },
      type,
      runner,
    })

    await this.sendOutput(callId, {
      status: 'scheduled',
      task_id: task.id,
      execute_at: args.execute_at,
      type,
      recurrence,
    }, turnId, task.id, {
      response: {
        instructions: [
          '用一句自然的话确认已设好提醒，包含具体时间和内容。',
          '不要调用工具，不要重复确认。',
        ].join(' '),
      },
    })
  }

  async executeMemoryToolCall({
    callId,
    turnId,
    generation,
    args,
    event,
    callContext,
  }) {
    const responseId = callContext.responseId || event.response_id || ''
    const deferred = this.beginDeferredToolResponse(responseId, {
      turnId,
      turnGeneration: generation,
    })
    try {
      await this.memory(callId, turnId, args, deferred
        ? { createResponse: false }
        : undefined)
    } catch (error) {
      await this.completeDeferredToolResponse(deferred, { failed: true })
      throw error
    }
    await this.completeDeferredToolResponse(deferred)
  }

  async executeCancelToolCall({
    callId,
    turnId,
    generation,
    args,
    event,
    callContext,
  }) {
    const responseId = String(
      callContext.responseId || event.response_id || '',
    ).trim()
    const firstCancelResponse = turnId
      ? this.cancelResponseByTurn.get(turnId)
      : null
    if (responseId && firstCancelResponse
      && firstCancelResponse !== responseId) {
      this.markTerminalToolResponse(responseId)
      await this.sendOutput(callId, {
        status: 'duplicate',
        message: '本轮取消操作已经处理，不再重复执行。',
      }, turnId, null, { createResponse: false })
      return
    }
    if (responseId && turnId && !firstCancelResponse) {
      this.cancelResponseByTurn.set(turnId, responseId)
      if (this.cancelResponseByTurn.size > 100) {
        this.cancelResponseByTurn.delete(
          this.cancelResponseByTurn.keys().next().value,
        )
      }
    }
    const deferred = this.beginDeferredToolResponse(responseId, {
      turnId,
      turnGeneration: generation,
    }, { instructions: CANCEL_RECEIPT_INSTRUCTIONS })
    let outputFailed = false
    try {
      await this.cancelAgentTask(
        callId,
        turnId,
        args,
        deferred
          ? { createResponse: false }
          : { response: { instructions: CANCEL_RECEIPT_INSTRUCTIONS } },
      )
    } catch (error) {
      outputFailed = true
      throw error
    } finally {
      await this.completeDeferredToolResponse(deferred, {
        failed: outputFailed,
      })
    }
  }

  async executeStatusToolCall({
    callId,
    turnId,
    args,
    event,
    callContext,
  }) {
    const responseId = String(
      callContext.responseId || event.response_id || '',
    ).trim()
    const spawnResponse = turnId
      ? this.spawnResponseByTurn.get(turnId)
      : null
    const firstStatusResponse = turnId
      ? this.statusResponseByTurn.get(turnId)
      : null
    const followsSpawnReceipt = Boolean(
      responseId && spawnResponse && responseId !== spawnResponse,
    )
    const repeatsStatusQuery = Boolean(
      responseId && firstStatusResponse && responseId !== firstStatusResponse,
    )
    if (followsSpawnReceipt || repeatsStatusQuery) {
      this.markTerminalToolResponse(responseId)
      await this.sendOutput(callId, {
        status: 'duplicate',
        message: '本轮不需要再次查询工作状态。',
      }, turnId, null, { createResponse: false })
      return
    }
    if (responseId && turnId && !firstStatusResponse) {
      this.statusResponseByTurn.set(turnId, responseId)
      if (this.statusResponseByTurn.size > 100) {
        this.statusResponseByTurn.delete(
          this.statusResponseByTurn.keys().next().value,
        )
      }
    }
    this.onAgentActivity({ activity: 'query', turnId })
    await this.getAgentTaskStatus(callId, turnId, args)
  }

  async executeSpawnThinkingToolCall({
    callId,
    turnId,
    generation,
    args,
    event,
    callContext,
  }) {
    const pendingPermissionTask = this.taskManager.list({
      ownerId: this.ownerId,
      sessionId: this.sessionId,
      active: true,
    }).find(task => task.authorization?.status === 'pending')
    if (pendingPermissionTask) {
      await this.sendOutput(
        callId,
        {
          status: 'authorization_pending',
          error: true,
          error_code: 'permission_decision_required',
          task_id: pendingPermissionTask.id,
          operation: pendingPermissionTask.authorization.summary,
          user_message: '当前有一项权限请求正在等待用户决定，不能把本轮回答提交成新工作。',
          retryable: true,
        },
        turnId,
        pendingPermissionTask.id,
        {
          response: {
            instructions: [
              '当前有一项权限请求正在等待决定，本轮不能调用 spawn_thinking。',
              '重新结合刚才提出的具体权限问题和本轮用户原话判断。',
              '若用户已自然表达同意或拒绝，立即调用 respond_permission；按语义判断，不要要求固定口令。',
              '若用户没有作出决定，只用一句自然的话继续确认。',
              '绝对不要代替用户同意，也不要声称权限已经生效。',
            ].join(' '),
          },
        },
      )
      return
    }

    // Receipt-based acceptance: this receipt only acknowledges intake, so it
    // must not wait on ASR timing or a live backend round trip. Availability
    // comes from the cached snapshot; a backend that looks healthy here but
    // fails at dispatch surfaces through the failed-task announcement path.
    const availability = this.backendAvailability?.snapshot()
      || { configured: true, ok: true, known: false }
    if (availability.configured === false) {
      await this.sendOutput(
        callId,
        failure(
          'backend_unavailable',
          '当前未配置后台 Agent，无法执行需要后台处理的任务。你仍然可以继续普通聊天。',
          { retryable: false },
        ),
        turnId,
        null,
        {
          response: {
            instructions: [
              '直接向用户说明当前未配置后台 Agent，无法执行这项后台任务。',
              '不要再次调用后台工具，也不要声称任务已经创建或正在执行。',
              '可以继续完成不需要后台 Agent 的聊天和回答。',
            ].join('\n'),
          },
        },
      )
      return
    }
    if (availability.known && availability.ok === false) {
      await this.sendOutput(
        callId,
        failure(
          'backend_unavailable',
          '后台 Agent 当前未连接。你仍然可以继续普通聊天，后台恢复后再执行这项工作。',
          { retryable: true },
        ),
        turnId,
        null,
        {
          response: {
            instructions: [
              '直接向用户说明后台 Agent 当前未连接，暂时无法执行这项后台任务。',
              '不要再次调用后台工具，也不要声称任务已经创建或正在执行。',
              '可以继续完成不需要后台 Agent 的聊天和回答。',
            ].join('\n'),
          },
        },
      )
      return
    }

    let objective = String(args.objective || '').replace(/\s+/g, ' ').trim()
    if (!objective) {
      // Rare model slip: only this fallback path waits for the transcript.
      const resolved = await this.transcripts.resolveDelegation(turnId, '')
      if (this.isStale(turnId, generation)) {
        await this.closeStaleCall(callId, turnId)
        return
      }
      objective = String(resolved.originalRequest || '').trim()
    }
    if (!objective) {
      await this.sendOutput(
        callId,
        failure(
          'missing_objective',
          '没有获得完整、可执行的目标，需要用户补充必要信息。',
          { retryable: true },
        ),
        turnId,
      )
      return
    }

    const responseId = String(
      callContext.responseId || event.response_id || '',
    ).trim()
    const firstSpawnResponse = turnId
      ? this.spawnResponseByTurn.get(turnId)
      : null
    if (responseId && firstSpawnResponse && firstSpawnResponse !== responseId) {
      this.markTerminalToolResponse(responseId)
      const existing = this.taskManager.list({
        ownerId: this.ownerId,
        sessionId: this.sessionId,
      }).find(item => item.turnId === turnId)
      await this.sendOutput(callId, {
        status: 'duplicate',
        ...(existing?.id ? { task_id: existing.id } : {}),
        message: '本轮工作已经提交，不再从工具回执继续创建任务。',
      }, turnId, existing?.id, { createResponse: false })
      return
    }
    if (responseId && turnId && !firstSpawnResponse) {
      this.spawnResponseByTurn.set(turnId, responseId)
      if (this.spawnResponseByTurn.size > 100) {
        this.spawnResponseByTurn.delete(
          this.spawnResponseByTurn.keys().next().value,
        )
      }
    }

    let task
    try {
      const historicalInputParts = this.inputAssets?.resolve({
        ownerId: this.ownerId,
        sessionId: this.sessionId,
        refs: args.input_refs,
      }) || []
      const delegatedInputParts = mergeInputParts(
        this.transcripts.parts(turnId),
        historicalInputParts,
      )
      const submissionKey = [
        'delegation',
        this.sessionId,
        turnId || callId,
        objectiveFingerprint(objective),
      ].join(':')
      task = this.createWork({
        turnId,
        objective,
        submissionKey,
        inputParts: delegatedInputParts,
      })
    } catch (error) {
      const message = String(error?.message || error || '')
      if (/输入.*失效|输入引用|找不到或无权访问/.test(message)) {
        await this.sendOutput(
          callId,
          failure(
            'invalid_input_ref',
            '引用的图片或文件已经失效，需要用户重新发送。',
            { retryable: true },
          ),
          turnId,
        )
        return
      }
      await this.sendOutput(
        callId,
        failure(
          'work_submission_failed',
          '暂时没有成功提交这次请求，请稍后重试。',
          { retryable: true },
        ),
        turnId,
      )
      return
    }
    const deferred = this.beginDeferredToolResponse(responseId, {
      turnId,
      turnGeneration: generation,
    })
    let outputFailed = false
    try {
      await this.sendOutput(
        callId,
        task.reused
          ? {
              status: 'duplicate',
              task_id: task.id,
              message: '同一工作此前已受理，请自然确认一次，不要再次调用工具。',
            }
          : {
              status: 'accepted',
              task_id: task.id,
              message: '工作已受理，请自然确认一次，不要再次调用工具。',
            },
        turnId,
        task.id,
        deferred
          ? { createResponse: false }
          : undefined,
      )
    } catch (error) {
      outputFailed = true
      throw error
    } finally {
      await this.completeDeferredToolResponse(deferred, {
        failed: outputFailed,
      })
    }
  }

  async handle(event, callContext = {}) {
    const callId = event.call_id || event.item?.call_id || ''
    const toolName = event.name || event.item?.name || ''
    if (!callId) throw new Error('Realtime 工具调用缺少 call_id')
    if (this.processedCalls.has(callId)) return
    this.processedCalls.add(callId)
    if (this.processedCalls.size > 500) {
      this.processedCalls.delete(this.processedCalls.values().next().value)
    }

    const turnId = callContext.turnId
      || event.__voiceContext?.turnId
      || this.getTurnId()
    const generation = Number.isInteger(callContext.turnGeneration)
      ? callContext.turnGeneration
      : Number.isInteger(event.__voiceContext?.turnGeneration)
        ? event.__voiceContext.turnGeneration
        : this.getTurnGeneration()
    let args = {}
    try {
      args = JSON.parse(event.arguments || '{}')
    } catch {
      // Invalid arguments are handled as missing fields below.
    }

    if (this.isStale(turnId, generation)) {
      await this.closeStaleCall(callId, turnId)
      return
    }

    const external = this.externalTool(toolName)
    const tool = frontendToolRegistry.get(toolName) || external?.tool
    if (tool) this.activeToolEntries.set(callId, tool)
    try {
      if (external) {
        return await this.executeExternalToolCall(external, {
          callId,
          turnId,
          turnGeneration: generation,
          args,
          event,
          callContext,
        })
      }
      const execution = await this.toolExecutor.execute(toolName, {
        callId,
        turnId,
        generation,
        args,
        event,
        callContext,
        frontend: {
          capabilities: [...new Set([
            ...(this.frontendRetrieval?.capabilities?.() || []),
            ...(this.frontendKnowledge?.capabilities?.() || []),
            // 与 realtime-gateway 的 getAgentContext 同一个判据：两处必须一致，
            // 否则会出现「模型看得到工具但调用被策略拒掉」这种自相矛盾的状态。
            // 与 realtime-gateway 的 getAgentContext 必须同一个判据。资料检索
            // 已归 knowledge 工具，所以这里只看会话摘要。
            ...(this.sessionDigests ? [FRONTEND_RECALL_CAPABILITY] : []),
            ...(this.hasPendingBackendPermission()
              ? [PERMISSION_RESPONSE_CAPABILITY]
              : []),
            ...(this.hasPendingBackendInput()
              ? [BACKEND_INPUT_RESPONSE_CAPABILITY]
              : []),
          ])],
        },
      })
      if (execution.handled && !execution.executed) {
        const responseId = String(
          callContext.responseId || event.response_id || '',
        ).trim()
        this.markTerminalToolResponse(responseId)
        await this.sendOutput(
          callId,
          execution.limit.reason === 'tool_unavailable'
            ? failure(
                'tool_unavailable',
                '当前前台没有启用这个能力。',
                { retryable: false },
              )
            : execution.limit.reason === 'repeated_call'
            ? {
                status: 'duplicate',
                message: '本轮相同操作已经处理，不再重复执行。',
              }
            : failure(
                'tool_loop_limit',
                '本轮工具调用已达到安全边界，已停止继续执行。',
                { retryable: true },
              ),
          turnId,
          null,
          { createResponse: execution.limit.reason === 'tool_unavailable' },
        )
        return execution
      }
      if (!execution.handled) {
        await this.sendOutput(
          callId,
          failure('unsupported_tool', '当前无法执行这个操作。'),
          turnId,
        )
      }
      return execution
    } finally {
      this.activeToolEntries.delete(callId)
    }
  }

  async enterSleep(callId, turnId) {
    if (!this.presenceController?.supportsSleep()) {
      await this.sendOutput(
        callId,
        failure('client_action_unsupported', '当前入口不支持休眠。'),
        turnId,
        null,
        { createResponse: true },
      )
      return
    }
    try {
      await this.presenceController.requestSleep({ source: 'realtime_tool' })
      await this.sendOutput(
        callId,
        { status: 'sleeping' },
        turnId,
        null,
        { createResponse: false },
      )
    } catch (error) {
      await this.sendOutput(
        callId,
        failure(
          error.code || 'client_action_failed',
          `休眠没有完成：${error.message}`,
          { retryable: true },
        ),
        turnId,
        null,
        { createResponse: true },
      )
    }
  }

  async webSearch({ callId, turnId, args }) {
    const query = String(args.query || '').trim()
    if (!query) {
      await this.sendOutput(
        callId,
        failure('missing_query', '需要提供要搜索的内容。'),
        turnId,
      )
      return
    }
    try {
      const result = await this.frontendRetrieval.search(query, {
        limit: args.limit,
      })
      await this.sendOutput(callId, result, turnId)
    } catch (error) {
      await this.sendOutput(
        callId,
        failure(
          error.code || 'web_search_failed',
          '网页搜索暂时不可用，请稍后再试。',
          { retryable: true },
        ),
        turnId,
      )
    }
  }

  async fetchUrl({ callId, turnId, args }) {
    const url = String(args.url || '').trim()
    if (!url) {
      await this.sendOutput(
        callId,
        failure('missing_url', '需要提供要读取的网址。'),
        turnId,
      )
      return
    }
    try {
      const result = await this.frontendRetrieval.fetchUrl(url)
      await this.sendOutput(callId, result, turnId)
    } catch (error) {
      const safeMessage = error.name === 'UrlFetchError'
        ? error.message
        : '网页暂时无法读取，请稍后再试。'
      await this.sendOutput(
        callId,
        failure(
          error.code || 'url_fetch_failed',
          safeMessage,
          { retryable: error.code !== 'private_network_forbidden' },
        ),
        turnId,
      )
    }
  }

  async knowledge({ callId, turnId, args }) {
    if (!this.frontendKnowledge) {
      await this.sendOutput(
        callId,
        failure('knowledge_unavailable', '前台知识库当前不可用。'),
        turnId,
      )
      return
    }
    try {
      const query = String(args.query || '').trim()
      const output = query
        ? await this.frontendKnowledge.search(query, {
            ownerId: this.ownerId,
            sessionId: this.sessionId,
            turnId,
            traceId: callId,
            knowledgeBaseIds: Array.isArray(args.knowledge_base_ids)
              ? args.knowledge_base_ids
              : [],
            topK: args.top_k,
          })
        : failure('missing_knowledge_query', '需要提供要检索的内容。')
      await this.sendOutput(callId, output, turnId)
    } catch (error) {
      await this.sendOutput(
        callId,
        failure(
          error?.code || 'knowledge_operation_failed',
          '暂时无法完成知识检索，请稍后重试。',
          { retryable: true },
        ),
        turnId,
      )
    }
  }

  notifyMemoryChanged() {
    try {
      this.onMemoryChanged()
    } catch {
      // Persistence succeeded even if a live prompt refresh did not.
    }
  }

  async respondAgentPermission({
    callId,
    turnId,
    generation,
    args,
    callContext,
  }) {
    const taskId = String(args.task_id || '').trim()
    const requestedPermissionId = String(args.permission_id || '').trim()
    const decision = String(args.decision || '').trim()
    const responseId = String(
      callContext?.responseId || callContext?.event?.response_id || '',
    ).trim()
    const response = ['once', 'always', 'reject'].includes(decision)
      ? {
          instructions: decision === 'reject'
            ? [
                '权限决定已提交。',
                '只用一句简短自然口语确认“已拒绝，后台不会执行这项操作”。',
                '不要重述操作，不要再次询问或调用工具。',
              ].join(' ')
            : decision === 'always'
              ? [
                '权限决定已提交，并在本会话立即生效。',
                '只用一句简短自然口语确认“已允许，后台继续执行”。',
                '不要重述操作，不要再次询问或调用工具。',
              ].join(' ')
              : [
                '本次权限决定已提交。',
                '只用一句简短自然口语确认“已允许，后台继续执行”。',
                '不要重述操作，不要再次询问或调用工具。',
              ].join(' '),
        }
      : null
    const deferred = this.beginDeferredToolResponse(responseId, {
      turnId,
      turnGeneration: generation,
    })
    const responseOptions = instructions => {
      if (deferred) {
        this.addDeferredToolResponseInstructions(deferred, instructions)
        return { createResponse: false }
      }
      return { response: { instructions } }
    }
    const invalidPermissionInstructions = [
      '当前没有真实、仍待确认的后台权限请求，任何相关操作都没有因此获得授权或开始执行。',
      '简短说明这次授权没有生效，不要伪造权限请求、工作 ID 或执行状态，也不要调用工具。',
    ].join(' ')
    let failed = false
    try {
      const transcript = String(await this.transcripts.transcript(turnId)).trim()
      if (!requestedPermissionId || !response || !transcript) {
        await this.sendOutput(
          callId,
          failure('invalid_permission_response', '没有找到有效的权限请求或决定。'),
          turnId,
          null,
          responseOptions(invalidPermissionInstructions),
        )
        return
      }
      const pendingTask = taskId
        ? this.taskManager.getByTaskId(taskId, { ownerId: this.ownerId })
        : this.taskManager.list({
            ownerId: this.ownerId,
            sessionId: this.sessionId,
            active: true,
          }).find(task => task.authorization?.id === requestedPermissionId)
      const trackedAuthorization = [...this.pendingBackendPermissions.entries()]
        .find(([id]) => permissionReference(id) === requestedPermissionId)
      const trackedPermission = trackedAuthorization?.[1]
      const trackedAuthorizationId = trackedAuthorization?.[0] || ''
      const authorizationId = (
        pendingTask
        && trackedPermission?.taskId === pendingTask.id
        && !this.submittedBackendPermissions.has(trackedAuthorizationId)
      ) || (
        pendingTask?.authorization?.status === 'pending'
        && permissionReference(pendingTask.authorization.id) === requestedPermissionId
      )
        ? trackedAuthorizationId || pendingTask.authorization.id
        : ''
      if (!pendingTask || pendingTask.sessionId !== this.sessionId || !authorizationId) {
        await this.sendOutput(
          callId,
          failure(
            'permission_not_pending',
            '当前工作没有真实待确认的权限请求，相关操作没有获得授权或开始执行。',
            { retryable: false },
          ),
          turnId,
          null,
          responseOptions(invalidPermissionInstructions),
        )
        return
      }
      if (!this.respondAuthorization) {
        await this.sendOutput(
          callId,
          failure('permission_unavailable', '当前后台无法接收权限决定。'),
          turnId,
          null,
          responseOptions('当前后台无法接收权限决定。简短说明授权没有生效，不要声称操作已经执行，也不要调用工具。'),
        )
        return
      }
      if (this.submittedBackendPermissions.has(authorizationId)) {
        const outputOptions = responseOptions([
          '该权限决定此前已经提交。',
          '只用一句简短自然口语说明后台正在继续处理，不要再次调用工具。',
        ].join(' '))
        await this.sendOutput(callId, {
          status: 'already_submitted',
          task_id: pendingTask.id,
        }, turnId, pendingTask.id, outputOptions)
        return
      }
      const previousPermissionMode = this.permissionPolicy?.mode(
        this.ownerId,
        this.sessionId,
      )
      this.permissionPolicy?.applyDecision(
        this.ownerId,
        this.sessionId,
        decision,
      )
      // Receipt-based: the local policy takes effect immediately and the backend
      // round trip must not delay the spoken confirmation. An "always" decision
      // also settles permissions that arrived concurrently for this same task.
      const permissions = decision === 'always'
        ? [...this.pendingBackendPermissions.entries()]
            .filter(([id, entry]) => (
              entry.taskId === pendingTask.id
              && !this.submittedBackendPermissions.has(id)
            ))
            .map(([id, entry]) => ({ id, taskId: entry.taskId }))
        : [{ id: authorizationId, taskId: pendingTask.id }]
      if (!permissions.some(permission => permission.id === authorizationId)) {
        permissions.push({ id: authorizationId, taskId: pendingTask.id })
      }
      permissions.forEach(permission => {
        this.submittedBackendPermissions.add(permission.id)
      })
      Promise.all(permissions.map(async permission => {
        try {
          await this.respondAuthorization(
            permission.taskId,
            permission.id,
            decision,
            { ownerId: this.ownerId },
          )
        } catch (error) {
          this.submittedBackendPermissions.delete(permission.id)
          try {
            this.onPermissionDeliveryFailed({
              authorizationId: permission.id,
              decision,
              taskId: permission.taskId,
              error: String(error?.message || error),
            })
          } catch {
            // Delivery diagnostics must not break the voice session.
          }
          throw error
        }
      })).catch(() => {
        if (previousPermissionMode) {
          this.permissionPolicy?.setMode(
            this.ownerId,
            this.sessionId,
            previousPermissionMode,
          )
        }
      })
      const outputOptions = responseOptions(response.instructions)
      await this.sendOutput(callId, {
        status: 'submitted',
        task_id: pendingTask.id,
      }, turnId, pendingTask.id, outputOptions)
    } catch (error) {
      failed = true
      throw error
    } finally {
      await this.completeDeferredToolResponse(deferred, { failed })
    }
  }

  async respondAgentInput({ callId, turnId, args }) {
    const taskId = String(args.task_id || '').trim()
    const action = ['accept', 'decline', 'cancel'].includes(args.action)
      ? args.action
      : ''
    const task = taskId ? this.taskManager.getByTaskId(taskId, {
      ownerId: this.ownerId,
    }) : null
    const request = task?.inputRequest
    if (
      !task
      || task.sessionId !== this.sessionId
      || request?.status !== 'pending'
      || !action
    ) {
      await this.sendOutput(callId, failure(
        'input_not_pending',
        '当前没有仍在等待回答的后台输入请求。',
      ), turnId, null, {
        response: { instructions: '简短说明这次回答没有提交成功，不要声称后台已经继续。' },
      })
      return
    }
    if (!this.respondInput) {
      await this.sendOutput(callId, failure(
        'input_unavailable',
        '当前后台无法接收补充输入。',
      ), turnId)
      return
    }
    await this.respondInput(task.id, request.id, {
      action,
      text: String(args.text || '').trim(),
      values: args.values,
    }, { ownerId: this.ownerId })
    await this.sendOutput(callId, {
      status: 'submitted',
      task_id: task.id,
    }, turnId, task.id, {
      response: {
        instructions: action === 'accept'
          ? '回答已交给原来的后台工作。只简短自然地说明会继续处理，不要新建工作或重复问题。'
          : '用户没有提供这次补充信息。只作简短自然确认，不要声称工作已经完成。',
      },
    })
  }

  async cancelAgentTask(callId, turnId, args, responseOptions) {
    if (args.all === true) {
      const targets = this.taskManager.list({
        ownerId: this.ownerId,
        sessionId: this.sessionId,
        active: true,
      })
      if (!targets.length) {
        await this.sendOutput(callId, {
          status: 'not_found',
          message: '当前没有仍在排队或执行的工作。',
        }, turnId, null, responseOptions)
        return
      }
      const results = await Promise.all(targets.map(target => (
        this.taskManager.cancel(target.id, { ownerId: this.ownerId })
      )))
      const cancelledCount = results.filter(result => (
        result?.status === 'cancelled'
      )).length
      await this.sendOutput(callId, {
        status: cancelledCount === targets.length ? 'cancelled' : 'partial',
        cancelled_count: cancelledCount,
        requested_count: targets.length,
        message: cancelledCount === targets.length
          ? '当前会话中的全部工作都已取消。'
          : '已取消仍可取消的工作，其余工作已经结束。',
      }, turnId, null, responseOptions)
      return
    }
    const requestedTaskId = String(args.task_id || '').trim()
    const target = requestedTaskId
      ? this.taskManager.getByTaskId(requestedTaskId, { ownerId: this.ownerId })
      : this.taskManager.list({
          ownerId: this.ownerId,
          sessionId: this.sessionId,
        }).find(task => [
          'scheduled',
          'queued',
          'running',
          'delegated',
          'finalizing',
        ].includes(task.status))
    if (!target) {
      await this.sendOutput(callId, {
        status: 'not_found',
        message: '当前没有仍在排队或执行的工作。',
      }, turnId, null, responseOptions)
      return
    }
    const task = await this.taskManager.cancel(target.id, {
      ownerId: this.ownerId,
    })
    if (!task) {
      await this.sendOutput(callId, {
        status: 'not_active',
        task_id: target.id,
        message: '这项工作已经结束，当前无法取消。',
      }, turnId, null, responseOptions)
      return
    }
    await this.sendOutput(callId, task.status === 'cancelled' ? {
      status: task.status,
      task_id: task.id,
      message: '已取消这项工作。',
    } : failure(
      'work_cancellation_failed',
      task.error || '没有成功取消这项工作。',
    ), turnId, task.id, responseOptions)
  }

  async getAgentTaskStatus(callId, turnId, args) {
    if (args.list_all === true) {
      // 不限定 sessionId：用户问「上周让你整理的那个报告呢」时已是新会话，
      // 限定当前会话会让历史工作永远查不到。
      const tasks = this.taskManager.list({
        ownerId: this.ownerId,
      }).slice(0, 20).map(task => ({
        task_id: task.id,
        status: task.status,
        kind: task.kind,
        objective: String(task.objective || '').slice(0, 300),
        execute_at: task.schedule?.at
          ? new Date(task.schedule.at).toISOString()
          : null,
        recurrence: task.schedule?.recurrence || null,
      }))
      await this.sendOutput(callId, {
        status: tasks.length ? 'ok' : 'empty',
        count: tasks.length,
        tasks,
        message: STATUS_RESULT_MESSAGE,
      }, turnId)
      return
    }
    const requestedTaskId = String(args.task_id || '').trim()
    const sessionTasks = this.taskManager.list({
      ownerId: this.ownerId,
      sessionId: this.sessionId,
    })
    const task = requestedTaskId
      ? this.taskManager.getByTaskId(requestedTaskId, { ownerId: this.ownerId })
      : sessionTasks.find(item => [
          'scheduled',
          'queued',
          'running',
          'delegated',
          'finalizing',
        ].includes(item.status)) || sessionTasks[0]
    if (!task) {
      await this.sendOutput(callId, {
        status: 'not_found',
        message: '还没有可查询的后台工作。',
      }, turnId)
      return
    }
    const consumesTaskNotification = (
      ['completed', 'failed'].includes(task.status)
      && ['pending', 'delivering'].includes(task.notificationStatus)
    )
    await this.sendOutput(callId, {
      status: 'ok',
      task_id: task.id,
      task_status: task.status,
      objective: task.objective.slice(0, 300),
      elapsed_ms: task.elapsedMs,
      delegation: task.delegation
        ? {
            status: task.delegation.status,
            title: task.delegation.title,
          }
        : null,
      authorization_pending: task.authorization?.status === 'pending',
      recent_updates: recentTaskUpdates(task.activity),
      latest_update: task.message
        ? String(task.message).slice(0, 1_000)
        : null,
      artifacts: (task.artifacts || []).slice(-8).map(artifact => ({
        artifact_id: artifact.artifactId,
        name: artifact.name || null,
        description: artifact.description || null,
      })),
      result: task.status === 'completed'
        ? String(task.result || '').slice(0, 500)
        : null,
      error: ['failed', 'cancelled'].includes(task.status)
        ? task.error
        : null,
      message: STATUS_RESULT_MESSAGE,
    }, turnId, task.id, {
      ...(consumesTaskNotification
        ? { responseContext: { consumesTaskNotification: true } }
        : {}),
    })
  }

  async getCurrentTime(callId, turnId) {
    await this.sendOutput(callId, {
      status: 'ok',
      ...currentTimeSnapshot(this.getClientContext()),
    }, turnId)
  }

  async memory(callId, turnId, args, responseOptions) {
    const action = String(args.action || '').trim().toLowerCase()
    const document = canonicalScope(String(args.document || (action === 'read' ? 'all' : '')))
    const oldText = String(args.old_text || '')
    const newText = String(args.new_text || '')
    const hasNewText = Object.prototype.hasOwnProperty.call(args, 'new_text')
    const content = String(args.content || '').trim()
    const proposedContent = action === 'append' ? content : newText
    let output
    if (!this.memoryService) {
      output = failure('memory_unavailable', '前台记忆功能当前不可用。')
    } else if (!['read', 'append', 'replace'].includes(action)) {
      output = failure('invalid_memory_action', '没有识别出要执行的记忆操作。')
    } else if (action === 'read') {
      const scope = document === 'all' ? null : document
      if (scope && !isMemoryDocument(scope)) {
        await this.sendOutput(callId, failure(
          'invalid_memory_document',
          '没有识别出要读取的记忆文档。',
        ), turnId, null, responseOptions)
        return
      }
      const memories = scope
        ? this.memoryService.list(this.ownerId, { scope })
        : this.memoryService.list(this.ownerId)
      output = {
        status: memories.length ? 'ok' : 'not_found',
        count: memories.length,
        documents: memories,
      }
    } else if (!isMemoryDocument(document)) {
      output = failure('invalid_memory_document', '写入记忆时必须指定 user 或 memory。')
    } else if (action === 'append' && !content) {
      output = failure('invalid_memory_edit', 'append 需要明确的 content。')
    } else if (action === 'replace' && (!oldText || !hasNewText)) {
      output = failure('invalid_memory_edit', 'replace 需要精确 old_text 和明确的 new_text。')
    } else if (SENSITIVE_MEMORY.test(proposedContent)) {
      output = failure(
        'sensitive_memory',
        '为了安全，不会保存密码、密钥、验证码或令牌。',
        { status: 'rejected' },
      )
    } else {
      try {
        const change = {
          document,
          edits: action === 'replace' ? [{ old_text: oldText, new_text: newText }] : [],
          append: action === 'append' ? content : '',
        }
        const changes = [change]
        const result = await this.memoryService.apply(this.ownerId, changes, {
          source: 'realtime-tool',
          sessionId: this.sessionId,
          turnId,
          traceId: callId,
        })
        if (result.changed) this.notifyMemoryChanged()
        output = {
          status: result.changed ? 'updated' : 'unchanged',
          changed: result.changed,
          documents: result.documents,
        }
      } catch (error) {
        if (['stale_document', 'edit_not_found', 'ambiguous_edit'].includes(error.code)) {
          output = failure(
            error.code,
            '记忆文档已经变化或原文没有精确匹配，请重新读取后再修改。',
            {
              retryable: true,
              documents: this.memoryService.list(this.ownerId),
            },
          )
        } else {
          output = failure(
            'memory_write_failed',
            '暂时无法修改记忆，请稍后再试。',
            { retryable: true },
          )
        }
      }
    }
    await this.sendOutput(callId, output, turnId, null, responseOptions)
  }

  async notes(callId, turnId, args) {
    const action = String(args.action || '').trim().toLowerCase()
    const listName = String(args.list || '').trim()
    const items = Array.isArray(args.items)
      ? args.items.map(item => String(item || '').trim()).filter(Boolean).slice(0, 20)
      : []
    let output
    if (!this.notesStore) {
      output = failure('notes_unavailable', '清单功能当前不可用。')
    } else if (!['lists', 'show', 'add', 'remove', 'clear', 'drop'].includes(action)) {
      output = failure('invalid_notes_action', '没有识别出要执行的清单操作。')
    } else if (action === 'lists') {
      const lists = this.notesStore.lists(this.ownerId)
      output = {
        status: lists.length ? 'ok' : 'empty',
        lists,
      }
    } else if (!listName) {
      output = failure('missing_notes_target', '需要明确要操作的清单名称。')
    } else if (action === 'show') {
      output = this.notesStore.show(this.ownerId, listName)
    } else if (action === 'add' || action === 'remove') {
      if (!items.length) {
        output = failure('missing_notes_items', '需要明确要添加或划掉的内容。')
      } else if (items.some(item => SENSITIVE_MEMORY.test(item))) {
        output = failure(
          'sensitive_notes',
          '为了安全，不会保存密码、密钥、验证码或令牌。',
          { status: 'rejected' },
        )
      } else {
        try {
          output = this.notesStore[action](this.ownerId, { list: listName, items })
        } catch {
          output = failure(
            'notes_write_failed',
            '暂时无法更新这条清单，请稍后再试。',
            { retryable: true },
          )
        }
      }
    } else {
      try {
        output = this.notesStore[action](this.ownerId, listName)
      } catch {
        output = failure(
          'notes_write_failed',
          '暂时无法更新这条清单，请稍后再试。',
          { retryable: true },
        )
      }
    }
    await this.sendOutput(callId, output, turnId)
  }

  // 只答「以前聊过什么、派过什么活」。用户自己的资料走 knowledge 工具 ——
  // 那一侧由 KnowledgeRetrievalProvider 负责，本机资料库的实现见
  // domain/domain-knowledge-provider.mjs。刻意不在这里兼管资料检索：
  // 两个查询类工具的职责重叠会让模型难选，而 knowledge 已经是主线的统一入口。
  async recall(callId, turnId, args) {
    const query = String(args.query || '').trim()
    const limit = Number(args.limit)
    if (!this.sessionDigests) {
      await this.sendOutput(
        callId,
        failure('recall_unavailable', '回顾以前记录的功能当前不可用。'),
        turnId,
      )
      return
    }

    let sessions = []
    let degraded = false
    try {
      sessions = this.recalledSessions(query, limit)
    } catch {
      degraded = true
    }

    let output
    if (sessions.length) {
      output = { status: 'found', sessions }
    } else if (degraded) {
      output = failure(
        'recall_failed',
        '暂时读不到以前的记录，请稍后再试。',
        { retryable: true },
      )
    } else if (query && this.recallHasAnything()) {
      output = { status: 'not_found', message: `没有找到和“${query}”有关的记录。` }
    } else {
      output = { status: 'empty', message: '还没有攒下以前的记录。' }
    }
    await this.sendOutput(callId, output, turnId)
  }

  recalledSessions(query, limit) {
    if (!this.sessionDigests) return []
    const timeZone = this.getClientContext()?.timeZone
    const now = Date.now()
    return this.sessionDigests
      .search({ ownerId: this.ownerId, keyword: query, limit })
      .map(digest => {
        const work = this.describeRecalledWork(digest.work)
        // 用条件展开而不是赋 undefined：后者仍会留下一个键，既让返回值多出
        // 噪声，也会让「不泄漏内部字段」这类白名单断言失去意义。
        return {
          ...describeWhen(digest.at, { now, timeZone }),
          topics: digest.topics,
          gist: digest.gist,
          ...(digest.turns ? { turns: digest.turns } : {}),
          ...(work.length ? { work } : {}),
        }
      })
  }

  // 资料条目一定要给 path —— 那就是交给后端 Agent 的地址，模型要把它写进
  // spawn_thinking 的 objective 里。sections 是原文章节标题，用来把 objective
  // 说准（「去查《X》的『年费规则』一节」），不是让模型自己回答内容。
  recallHasAnything() {
    return (this.sessionDigests?.count(this.ownerId) || 0) > 0
  }

  // 摘要里只冻结了「派过什么活」，状态一律在这里从任务台账实时读 ——
  // 存进摘要就会冻结，过几天那个值就是错的。台账终态只留 3 天，更早的活
  // 查不到台账记录，此时不给 status，只报「派过」，这是刻意的降级。
  describeRecalledWork(work = []) {
    return work.map(item => {
      const task = item.id
        ? this.taskManager.get(item.id, { ownerId: this.ownerId })
        : null
      return task
        ? { objective: item.objective, status: task.status }
        : { objective: item.objective, status: 'unknown' }
    })
  }
}
