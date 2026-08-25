import { createHash } from 'node:crypto'
import {
  CANCEL_AGENT_TASK_TOOL_NAME,
  SCHEDULE_REMINDER_TOOL_NAME,
  SPAWN_THINKING_TOOL_NAME,
  GET_AGENT_TASK_STATUS_TOOL_NAME,
  GET_CURRENT_TIME_TOOL_NAME,
  ENTER_SLEEP_TOOL_NAME,
  NOTES_TOOL_NAME,
  MEMORY_TOOL_NAME,
  RESPOND_AGENT_PERMISSION_TOOL_NAME,
} from '../frontend-tools.mjs'
import { currentTimeSnapshot } from '../../conversation/frontend-agent-context.mjs'
import { canonicalScope, isMemoryDocument } from '../../core/memory-scopes.mjs'
import { inputPartRef } from '../../../../shared/input-parts.mjs'

const SENSITIVE_MEMORY = /(?:pass(?:word)?|secret|api[_ -]?key|access[_ -]?token|credential|验证码|密码|密钥|令牌|\bsk-[a-z0-9_-]+)/i

const CANCEL_RECEIPT_INSTRUCTIONS = [
  '根据本次响应中的全部取消结果，只作一次简短自然的确认。',
  '不要逐项复述 job_id，不要再次查询或取消，不要调用其他工具。',
].join(' ')

const STATUS_RESULT_MESSAGE = '请根据这次查询结果自然回答用户；不要再次调用状态工具，不要展示 job_id。'

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
    coordinator,
    backendAvailability = null,
    memoryService,
    notesStore,
    getClientContext = () => ({}),
    getConversationContext = () => [],
    onMemoryChanged = () => {},
    respondPermission,
    permissionPolicy,
    onPermissionDeliveryFailed = () => {},
    requestClientState = () => {},
    onAgentActivity = () => {},
    inputAssets = null,
  }) {
    this.taskManager = taskManager
    this.ownerId = ownerId
    this.sessionId = sessionId
    this.transcripts = transcripts
    this.getFrontend = getFrontend
    this.getTurnId = getTurnId
    this.getTurnGeneration = getTurnGeneration
    this.coordinator = coordinator
    this.backendAvailability = backendAvailability
    this.memoryService = memoryService
    this.notesStore = notesStore
    this.getClientContext = getClientContext
    this.getConversationContext = getConversationContext
    this.onMemoryChanged = onMemoryChanged
    this.respondPermission = respondPermission
    this.permissionPolicy = permissionPolicy
    this.onPermissionDeliveryFailed = onPermissionDeliveryFailed
    this.requestClientState = requestClientState
    this.onAgentActivity = onAgentActivity
    this.inputAssets = inputAssets
    this.gatewayApprovedPermissions = new Set()
    this.processedCalls = new Set()
    this.spawnResponseByTurn = new Map()
    this.statusResponseByTurn = new Map()
    this.cancelResponseByTurn = new Map()
    this.terminalToolResponses = new Set()
    this.deferredToolResponses = new Map()
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
    await this.getFrontend()?.sendFunctionOutput(
      callId,
      output,
      { turnId, taskId, ...(responseContext || {}) },
      frontendOptions,
    )
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

  forwardCoordinatorEvent(event, onEvent) {
    const permission = event?.permission
    if (
      event?.type === 'backend.permission.resolved'
      && permission?.id
      && this.gatewayApprovedPermissions.delete(permission.id)
    ) return
    if (
      event?.type !== 'backend.permission.requested'
      || !permission?.id
      || !this.respondPermission
      || !this.permissionPolicy?.shouldAutoAllow(
        this.ownerId,
        this.sessionId,
      )
    ) {
      onEvent(event)
      return
    }
    this.gatewayApprovedPermissions.add(permission.id)
    let approval
    try {
      approval = this.respondPermission(
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
    verbatimRequest,
    submissionKey,
    inputParts = [],
  }) {
    let workId = ''
    let requestId = ''
    const task = this.taskManager.create({
      objective,
      ownerId: this.ownerId,
      sessionId: this.sessionId,
      turnId,
      submissionKey,
      laneKey: `coordinator:${this.ownerId}`,
      laneLimit: 1,
      runner: async (_ignored, { onEvent, signal }) => {
        // The verbatim request was pinned at acceptance and is almost
        // certainly settled by now; awaiting it never blocks the receipt.
        const resolved = (await verbatimRequest) || {}
        return this.coordinator.run({
          originalRequest: resolved.originalRequest || objective,
          objective,
          conversationContext: this.getConversationContext(),
          userMemories: this.memoryService?.list(this.ownerId, { limit: 64 }) || [],
          timeZone: this.getClientContext()?.timeZone,
          workingDirectory: this.getClientContext()?.workingDirectory,
          inputParts: mergeInputParts(inputParts, resolved.inputParts || []),
        }, {
          ownerId: this.ownerId,
          sessionId: this.sessionId,
          turnId,
          coordinationRunId: workId,
          coordinationRequestId: requestId,
          signal,
          onEvent: event => this.forwardCoordinatorEvent(event, onEvent),
        })
      },
      canceler: async ({ previousStatus, abort }) => {
        const result = await this.coordinator.cancelWork(
          workId,
          { ownerId: this.ownerId },
        )
        abort()
        return {
          ...result,
          layer: previousStatus === 'finalizing'
            ? 'finalizing'
            : result?.layer || 'coordinator',
        }
      },
    })
    workId = task.id
    requestId = task.jobId
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

    // For type='task', build a coordinator runner that will execute the
    // objective when the scheduled task fires. The coordinator singleton
    // and ownerId are safe to capture — they outlive the voice session.
    const coordinator = this.coordinator
    const memoryService = this.memoryService
    const runner = type === 'task'
      ? async (objective, context) => coordinator.run({
          originalRequest: objective,
          objective,
          conversationContext: [],
          // Resolve at execution time so a future task sees the user's latest
          // model and long-term memory, not a snapshot from when it was set.
          userMemories: memoryService?.list(
            context.ownerId,
            { limit: 64 },
          ) || [],
        }, {
          ownerId: context.ownerId,
          sessionId: context.sessionId,
          turnId: context.turnId,
          coordinationRunId: context.taskId,
          coordinationRequestId: context.jobId,
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
      job_id: task.jobId,
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

    if (toolName === GET_CURRENT_TIME_TOOL_NAME) {
      await this.getCurrentTime(callId, turnId)
      return
    }
    if (toolName === MEMORY_TOOL_NAME) {
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
      return
    }
    if (toolName === NOTES_TOOL_NAME) {
      await this.notes(callId, turnId, args)
      return
    }
    if (toolName === SCHEDULE_REMINDER_TOOL_NAME) {
      await this.handleScheduleReminder(callId, turnId, args)
      return
    }
    if (toolName === CANCEL_AGENT_TASK_TOOL_NAME) {
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
      return
    }
    if (toolName === GET_AGENT_TASK_STATUS_TOOL_NAME) {
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
      return
    }
    if (toolName === RESPOND_AGENT_PERMISSION_TOOL_NAME) {
      await this.respondAgentPermission(callId, turnId, args)
      return
    }
    if (toolName === ENTER_SLEEP_TOOL_NAME) {
      await this.enterSleep(callId, turnId)
      return
    }
    if (toolName !== SPAWN_THINKING_TOOL_NAME) {
      await this.sendOutput(
        callId,
        failure('unsupported_tool', '当前无法执行这个操作。'),
        turnId,
      )
      return
    }

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
          authorization_id: pendingPermissionTask.authorization.id,
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
              '若用户已自然表达同意或拒绝，立即调用 respond_agent_permission；按语义判断，不要要求固定口令。',
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
        ...(existing?.jobId ? { job_id: existing.jobId } : {}),
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
      // Pin the verbatim user request without blocking the receipt: the
      // transcript waiter registers now, so the ASR result is captured even
      // if the per-connection ring buffer evicts that turn before the FIFO
      // lane dispatches this work. resolveDelegation never rejects and a
      // closed session resolves to the model-provided objective.
      const verbatimRequest = this.transcripts.resolveDelegation(
        turnId,
        objective,
      )
      task = this.createWork({
        turnId,
        objective,
        verbatimRequest,
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
              job_id: task.jobId,
              message: '同一工作此前已受理，请自然确认一次，不要再次调用工具。',
            }
          : {
              status: 'accepted',
              job_id: task.jobId,
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

  async enterSleep(callId, turnId) {
    const supported = this.getClientContext()?.states?.includes('sleeping')
    if (!supported) {
      await this.sendOutput(
        callId,
        failure('unsupported_client_state', '当前入口不支持休眠。'),
        turnId,
      )
      return
    }
    await this.sendOutput(
      callId,
      { status: 'sleeping' },
      turnId,
      null,
      { createResponse: false },
    )
    this.requestClientState('sleeping')
  }

  notifyMemoryChanged() {
    try {
      this.onMemoryChanged()
    } catch {
      // Persistence succeeded even if a live prompt refresh did not.
    }
  }

  async respondAgentPermission(callId, turnId, args) {
    const authorizationId = String(args.authorization_id || '').trim()
    const decision = String(args.decision || '').trim()
    const transcript = String(await this.transcripts.transcript(turnId)).trim()
    if (
      !authorizationId
      || !['always', 'reject'].includes(decision)
      || !transcript
    ) {
      await this.sendOutput(
        callId,
        failure('invalid_permission_response', '没有找到有效的权限请求或决定。'),
        turnId,
      )
      return
    }
    const pendingTask = this.taskManager.list({
      ownerId: this.ownerId,
      sessionId: this.sessionId,
      active: true,
    }).find(task => task.authorization?.id === authorizationId)
    if (!pendingTask) {
      await this.sendOutput(
        callId,
        failure(
          'permission_not_pending',
          '这项权限请求已经处理过或不属于当前任务；若用户刚在界面上确认过，'
          + '无需重复回应，直接继续即可。',
          { retryable: false },
        ),
        turnId,
      )
      return
    }
    if (!this.respondPermission) {
      await this.sendOutput(
        callId,
        failure('permission_unavailable', '当前后台无法接收权限决定。'),
        turnId,
      )
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
    // Receipt-based: the local policy takes effect immediately and the ACP
    // round trip must not delay the spoken confirmation. On delivery failure
    // the policy rolls back and the authorization is still pending on the
    // backend, so the gateway can re-announce it through the existing
    // pending-permission retry path.
    Promise.resolve()
      .then(() => this.respondPermission(
        authorizationId,
        decision,
        { ownerId: this.ownerId },
      ))
      .catch(error => {
        if (previousPermissionMode) {
          this.permissionPolicy?.setMode(
            this.ownerId,
            this.sessionId,
            previousPermissionMode,
          )
        }
        try {
          this.onPermissionDeliveryFailed({
            authorizationId,
            decision,
            taskId: pendingTask.id,
            error: String(error?.message || error),
          })
        } catch {
          // Delivery diagnostics must not break the voice session.
        }
      })
    await this.sendOutput(callId, {
      status: 'submitted',
      authorization_id: authorizationId,
    }, turnId, pendingTask.id, {
      response: {
        instructions: decision === 'always'
          ? [
              '权限决定已提交，并在本会话立即生效。',
              '只用一句简短自然口语确认“已允许，后台继续执行”。',
              '不要重述操作，不要再次询问或调用工具。',
            ].join(' ')
          : [
              '权限决定已提交。',
              '只用一句简短自然口语确认“已拒绝，后台不会执行这项操作”。',
              '不要重述操作，不要再次询问或调用工具。',
            ].join(' '),
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
    const requestedJobId = String(args.job_id || '').trim()
    const target = requestedJobId
      ? this.taskManager.getByJobId(requestedJobId, { ownerId: this.ownerId })
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
        job_id: target.jobId,
        message: '这项工作已经结束，当前无法取消。',
      }, turnId, null, responseOptions)
      return
    }
    await this.sendOutput(callId, task.status === 'cancelled' ? {
      status: task.status,
      job_id: task.jobId,
      message: '已取消这项工作。',
    } : failure(
      'work_cancellation_failed',
      task.error || '没有成功取消这项工作。',
    ), turnId, task.id, responseOptions)
  }

  async getAgentTaskStatus(callId, turnId, args) {
    if (args.list_all === true) {
      const tasks = this.taskManager.list({
        ownerId: this.ownerId,
        sessionId: this.sessionId,
      }).slice(0, 20).map(task => ({
        job_id: task.jobId,
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
    const requestedJobId = String(args.job_id || '').trim()
    const sessionTasks = this.taskManager.list({
      ownerId: this.ownerId,
      sessionId: this.sessionId,
    })
    const task = requestedJobId
      ? this.taskManager.getByJobId(requestedJobId, { ownerId: this.ownerId })
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
        message: '当前语音会话中还没有可查询的后台工作。',
      }, turnId)
      return
    }
    const consumesTaskNotification = (
      ['completed', 'failed'].includes(task.status)
      && ['pending', 'delivering'].includes(task.notificationStatus)
    )
    await this.sendOutput(callId, {
      status: 'ok',
      job_id: task.jobId,
      work_status: task.status,
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
        const result = this.memoryService.apply(this.ownerId, changes)
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
}
