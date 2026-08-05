import {
  CANCEL_AGENT_TASK_TOOL_NAME,
  SCHEDULE_REMINDER_TOOL_NAME,
  DELEGATE_TOOL_NAME,
  GET_AGENT_TASK_STATUS_TOOL_NAME,
  GET_CURRENT_TIME_TOOL_NAME,
  ENTER_SLEEP_TOOL_NAME,
  NOTES_TOOL_NAME,
  USER_MEMORY_TOOL_NAME,
  RESPOND_AGENT_PERMISSION_TOOL_NAME,
} from '../realtime-provider.mjs'
import { currentTimeSnapshot } from '../../conversation/frontend-agent-context.mjs'
import { isToolScope } from '../../core/memory-scopes.mjs'

const SENSITIVE_MEMORY = /(?:pass(?:word)?|secret|api[_ -]?key|access[_ -]?token|credential|验证码|密码|密钥|令牌|\bsk-[a-z0-9_-]+)/i

function failure(errorCode, userMessage, {
  retryable = false,
  status = 'failed',
} = {}) {
  return {
    status,
    error: true,
    error_code: errorCode,
    user_message: userMessage,
    retryable,
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
    coordinatorAvailable = async () => true,
    memoryStore,
    notesStore,
    getClientContext = () => ({}),
    getConversationContext = () => [],
    onMemoryChanged = () => {},
    respondPermission,
    permissionPolicy,
    requestClientState = () => {},
  }) {
    this.taskManager = taskManager
    this.ownerId = ownerId
    this.sessionId = sessionId
    this.transcripts = transcripts
    this.getFrontend = getFrontend
    this.getTurnId = getTurnId
    this.getTurnGeneration = getTurnGeneration
    this.coordinator = coordinator
    this.coordinatorAvailable = coordinatorAvailable
    this.memoryStore = memoryStore
    this.notesStore = notesStore
    this.getClientContext = getClientContext
    this.getConversationContext = getConversationContext
    this.onMemoryChanged = onMemoryChanged
    this.respondPermission = respondPermission
    this.permissionPolicy = permissionPolicy
    this.requestClientState = requestClientState
    this.gatewayApprovedPermissions = new Set()
    this.processedCalls = new Set()
    this.turnTasks = new Map()
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

  createWork({ turnId, originalRequest, objective, submissionKey }) {
    let workId = ''
    const task = this.taskManager.create({
      objective: originalRequest,
      ownerId: this.ownerId,
      sessionId: this.sessionId,
      turnId,
      submissionKey,
      laneKey: `coordinator:${this.ownerId}`,
      laneLimit: 1,
      runner: async (_ignored, { onEvent, signal }) => this.coordinator.run({
        originalRequest,
        objective,
        conversationContext: this.getConversationContext(),
        userMemories: this.memoryStore?.list(this.ownerId, { limit: 64 }) || [],
        timeZone: this.getClientContext()?.timeZone,
        workingDirectory: this.getClientContext()?.workingDirectory,
      }, {
        ownerId: this.ownerId,
        sessionId: this.sessionId,
        turnId,
        coordinationRunId: workId,
        signal,
        onEvent: event => this.forwardCoordinatorEvent(event, onEvent),
      }),
      canceler: async ({ previousStatus, abort }) => {
        if (previousStatus === 'delegated') {
          const result = await this.coordinator.cancelDelegatedWork(
            workId,
            { ownerId: this.ownerId },
          )
          abort()
          return result
        }
        abort()
        return {
          route: 'adapter',
          layer: previousStatus === 'finalizing' ? 'finalizing' : 'coordinator',
        }
      },
    })
    workId = task.id
    this.turnTasks.set(turnId, task.id)
    if (this.turnTasks.size > 100) {
      this.turnTasks.delete(this.turnTasks.keys().next().value)
    }
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
    const ownerId = this.ownerId
    const runner = type === 'task'
      ? async (objective, { onEvent, signal }) => coordinator.run({
          originalRequest: objective,
          objective,
          conversationContext: [],
          userMemories: [],
        }, {
          ownerId,
          signal,
          onEvent,
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
      reminder_id: task.id,
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
    if (toolName === USER_MEMORY_TOOL_NAME) {
      await this.userMemory(callId, turnId, args)
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
      await this.cancelAgentTask(callId, turnId, args)
      return
    }
    if (toolName === GET_AGENT_TASK_STATUS_TOOL_NAME) {
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
    if (toolName !== DELEGATE_TOOL_NAME) {
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

    const resolved = await this.transcripts.resolveDelegation(
      turnId,
      args.objective,
    )
    if (this.isStale(turnId, generation)) {
      await this.closeStaleCall(callId, turnId)
      return
    }
    const originalRequest = String(
      resolved.originalRequest || resolved.objective || '',
    ).trim()
    const objective = String(
      resolved.objective || resolved.originalRequest || '',
    ).trim()
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

    let coordinatorReady = false
    let coordinatorConfigured = true
    try {
      const availability = await this.coordinatorAvailable()
      if (availability && typeof availability === 'object') {
        coordinatorConfigured = availability.enabled !== false
        coordinatorReady = (
          coordinatorConfigured && availability.ok === true
        )
      } else {
        coordinatorReady = availability === true
      }
    } catch {
      coordinatorReady = false
    }
    if (!coordinatorReady) {
      const userMessage = coordinatorConfigured
        ? '后台 Agent 当前未连接。你仍然可以继续普通聊天，后台恢复后再执行这项工作。'
        : '当前未配置后台 Agent，无法执行需要后台处理的任务。你仍然可以继续普通聊天。'
      await this.sendOutput(
        callId,
        failure(
          'backend_unavailable',
          userMessage,
          { retryable: coordinatorConfigured },
        ),
        turnId,
        null,
        {
          response: {
            instructions: [
              coordinatorConfigured
                ? '直接向用户说明后台 Agent 当前未连接，暂时无法执行这项后台任务。'
                : '直接向用户说明当前未配置后台 Agent，无法执行这项后台任务。',
              '不要再次调用后台工具，也不要声称任务已经创建或正在执行。',
              '可以继续完成不需要后台 Agent 的聊天和回答。',
            ].join('\n'),
          },
        },
      )
      return
    }

    const existingId = this.turnTasks.get(turnId)
    if (existingId) {
      await this.sendOutput(
        callId,
        {
          status: 'duplicate',
          work_id: existingId,
          message: '这一轮已经提交，不要重复执行。',
        },
        turnId,
        existingId,
        {
          response: {
            instructions: [
              '这个任务已经在本轮成功提交，不要再次调用工具。',
              '结合本轮调用工具前已经对用户说过的内容，自主判断是否需要回应。',
              '如果此前已经说明正在处理，不要重复、改写或补充确认，直接结束本次响应。',
              '只有此前没有作出任何确认时，才用包含具体任务对象的短句说明已经开始处理。',
              '不要把 accepted 或 duplicate 说成任务已经完成。',
            ].join(' '),
          },
        },
      )
      return
    }

    let task
    try {
      const submissionKey = [
        'delegation',
        this.sessionId,
        turnId || callId,
      ].join(':')
      task = this.createWork({
        turnId,
        originalRequest,
        objective,
        submissionKey,
      })
    } catch {
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
    await this.sendOutput(
      callId,
      task.reused
        ? {
            status: 'duplicate',
            work_id: task.id,
            message: '这一轮已经提交，不要重复执行。',
          }
        : {
            status: 'accepted',
            marker: '[thinking]',
            work_id: task.id,
          },
      turnId,
      task.id,
      {
        // Always let Realtime close the tool-call turn itself. Whether it
        // should say anything is a semantic decision based on what it already
        // said before invoking the tool.
        response: {
          instructions: [
            '结合本轮调用工具前已经对用户说过的内容，自主判断是否需要回应。',
            '如果此前已经说明正在处理，不要重复、改写或补充确认，直接结束本次响应。',
            '只有此前没有作出任何确认时，才用包含具体任务对象的短句说明已经开始处理；避免“好的、收到”等通用承接语。',
            'accepted 或 duplicate 只代表任务已经提交，不代表已经完成。',
          ].join(' '),
        },
      },
    )
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
          '这项权限请求已经失效或不属于当前任务。',
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
    try {
      const permission = await this.respondPermission(
        authorizationId,
        decision,
        { ownerId: this.ownerId },
      )
      await this.sendOutput(callId, {
        status: permission.status,
        authorization_id: permission.id,
      }, turnId, permission.workId, {
        response: {
          instructions: decision === 'always'
            ? [
                '权限已经成功生效。',
                '只用一句简短自然口语确认“已允许，后台继续执行”。',
                '不要重述操作，不要再次询问或调用工具。',
              ].join(' ')
            : [
                '权限已经成功拒绝。',
                '只用一句简短自然口语确认“已拒绝，后台不会执行这项操作”。',
                '不要重述操作，不要再次询问或调用工具。',
              ].join(' '),
        },
      })
    } catch (error) {
      if (previousPermissionMode) {
        this.permissionPolicy?.setMode(
          this.ownerId,
          this.sessionId,
          previousPermissionMode,
        )
      }
      await this.sendOutput(
        callId,
        failure(
          'permission_response_failed',
          error?.message || '没有成功提交权限决定。',
          { retryable: false },
        ),
        turnId,
      )
    }
  }

  async cancelAgentTask(callId, turnId, args) {
    const requestedId = String(args.work_id || '').trim()
    const targetId = requestedId || this.taskManager.list({
      ownerId: this.ownerId,
      sessionId: this.sessionId,
      active: true,
    })[0]?.id
    if (!targetId) {
      await this.sendOutput(callId, {
        status: 'not_found',
        message: '当前没有仍在排队或执行的工作。',
      }, turnId)
      return
    }
    const relatedQueries = this.taskManager.list({
      ownerId: this.ownerId,
      active: true,
      includeControl: true,
    }).filter(task => (
      task.kind === 'control'
      && task.parentWorkId === targetId
    ))
    await Promise.all(relatedQueries.map(task => (
      this.taskManager.cancel(task.id, { ownerId: this.ownerId })
    )))
    const task = await this.taskManager.cancel(targetId, {
      ownerId: this.ownerId,
    })
    if (!task) {
      await this.sendOutput(callId, {
        status: 'not_active',
        work_id: targetId,
        message: '这项工作已经结束，当前无法取消。',
      }, turnId)
      return
    }
    await this.sendOutput(callId, task.status === 'cancelled' ? {
      status: task.status,
      work_id: task.id,
      message: '已取消这项工作。',
    } : failure(
      'work_cancellation_failed',
      task.error || '没有成功取消这项工作。',
    ), turnId, task.id)
  }

  async getAgentTaskStatus(callId, turnId, args) {
    const requestedId = String(args.work_id || '').trim()
    const task = requestedId
      ? this.taskManager.get(requestedId, { ownerId: this.ownerId })
      : this.taskManager.list({
          ownerId: this.ownerId,
          sessionId: this.sessionId,
        })[0]
    if (!task) {
      await this.sendOutput(callId, {
        status: 'not_found',
        message: '当前语音会话中还没有可查询的后台工作。',
      }, turnId)
      return
    }
    if (task.status === 'delegated') {
      const existing = this.taskManager.list({
        ownerId: this.ownerId,
        sessionId: this.sessionId,
        active: true,
        includeControl: true,
      }).find(item => (
        item.kind === 'control'
        && item.parentWorkId === task.id
      ))
      if (existing) {
        await this.sendOutput(callId, {
          status: 'querying',
          work_id: task.id,
          query_work_id: existing.id,
          message: '这个项目的状态和进度已经在查询中。',
        }, turnId, task.id)
        return
      }
      const transcript = String(
        args.question || await this.transcripts.transcript(turnId) || '',
      ).trim()
      const query = this.taskManager.create({
        kind: 'control',
        parentWorkId: task.id,
        priority: 100,
        objective: `查询“${task.objective.slice(0, 200)}”的状态：${
          transcript || '查询当前状态和进度'
        }`,
        ownerId: this.ownerId,
        sessionId: this.sessionId,
        turnId,
        laneKey: `coordinator:${this.ownerId}`,
        laneLimit: 1,
        runner: async (_ignored, { signal }) => {
          try {
            return await this.coordinator.queryDelegatedWork(
              task.id,
              transcript || '用户想了解这个第三层任务当前的状态和进度。',
              {
                ownerId: this.ownerId,
                signal,
              },
            )
          } catch (error) {
            const latest = this.taskManager.get(task.id, {
              ownerId: this.ownerId,
            })
            if (latest && latest.status !== 'delegated') {
              const messages = {
                completed: '这项工作已经完成，最终结果正在或已经交付。',
                finalizing: '项目执行已经完成，系统正在整理最终结果。',
                cancelled: '这项工作已经取消。',
                failed: `这项工作已经失败：${latest.error || '没有更多错误信息。'}`,
              }
              return {
                content: messages[latest.status]
                  || `这项工作当前状态是 ${latest.status}。`,
                metadata: {
                  parentWorkId: task.id,
                  resolvedFromLedger: true,
                },
              }
            }
            throw error
          }
        },
        canceler: async ({ abort }) => {
          abort()
          return {
            route: 'gateway',
            layer: 'delegated_status_query',
          }
        },
      })
      await this.sendOutput(callId, {
        status: 'querying',
        work_id: task.id,
        query_work_id: query.id,
        message: '正在查询这个项目的状态和进度，结果出来后会自动告诉你。',
      }, turnId, task.id)
      return
    }
    const lastActivity = task.activity.at(-1)
    const consumesTaskNotification = (
      ['completed', 'failed'].includes(task.status)
      && ['pending', 'delivering'].includes(task.notificationStatus)
    )
    await this.sendOutput(callId, {
      status: 'ok',
      work_id: task.id,
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
      last_activity: lastActivity
        ? {
            category: lastActivity.category || lastActivity.kind,
            status: lastActivity.status,
            detail: String(lastActivity.detail || '').slice(0, 160),
          }
        : null,
      result: task.status === 'completed'
        ? String(task.result || '').slice(0, 500)
        : null,
      error: ['failed', 'cancelled'].includes(task.status)
        ? task.error
        : null,
    }, turnId, task.id, consumesTaskNotification
      ? { responseContext: { consumesTaskNotification: true } }
      : undefined)
  }

  async getCurrentTime(callId, turnId) {
    await this.sendOutput(callId, {
      status: 'ok',
      ...currentTimeSnapshot(this.getClientContext()),
    }, turnId)
  }

  async userMemory(callId, turnId, args) {
    const action = String(args.action || '').trim().toLowerCase()
    const scope = String(args.scope || '').trim().toLowerCase()
    const content = String(args.content || '').trim()
    const query = String(args.query || '').trim()
    const memoryIds = Array.isArray(args.memory_ids)
      ? args.memory_ids.map(id => String(id || '').trim()).filter(Boolean).slice(0, 20)
      : []
    const all = args.all === true
    let output
    if (!this.memoryStore) {
      output = failure('memory_unavailable', '前台记忆功能当前不可用。')
    } else if (!['recall', 'remember', 'replace', 'forget'].includes(action)) {
      output = failure('invalid_memory_action', '没有识别出要执行的记忆操作。')
    } else if (!isToolScope(scope)) {
      output = failure('invalid_memory_scope', '没有识别出记忆范围。')
    } else if (action === 'recall') {
      const memories = this.memoryStore.list(this.ownerId, { scope, query })
      output = {
        status: memories.length ? 'ok' : 'not_found',
        count: memories.length,
        memories,
      }
    } else if (action === 'remember' || action === 'replace') {
      if (scope === 'all' || !content) {
        output = failure('missing_memory', '需要明确记忆类型和要记住的内容。')
      } else if (action === 'replace' && !memoryIds.length) {
        output = failure(
          'missing_memory_ids',
          '需要先找到要被新事实取代的旧记忆。',
          { retryable: true },
        )
      } else if (SENSITIVE_MEMORY.test(content)) {
        output = failure(
          'sensitive_memory',
          '为了安全，不会保存密码、密钥、验证码或令牌。',
          { status: 'rejected' },
        )
      } else {
        try {
          if (action === 'replace') {
            const result = this.memoryStore.replace(this.ownerId, {
              scope,
              ids: memoryIds,
              content,
            })
            output = {
              status: result.replaced ? 'replaced' : 'not_found',
              ...result,
            }
            if (result.replaced) this.notifyMemoryChanged()
          } else {
            output = {
              status: 'remembered',
              memory: this.memoryStore.remember(this.ownerId, { scope, content }),
            }
            this.notifyMemoryChanged()
          }
        } catch {
          output = failure(
            'memory_write_failed',
            '暂时无法保存这项记忆，请稍后再试。',
            { retryable: true },
          )
        }
      }
    } else {
      if (!all && !query) {
        output = failure('missing_memory_query', '需要明确要遗忘的内容。')
      } else {
        try {
          const removed = this.memoryStore.forget(this.ownerId, {
            scope,
            query,
            all,
          })
          if (removed) this.notifyMemoryChanged()
          output = { status: removed ? 'forgotten' : 'not_found', removed }
        } catch {
          output = failure(
            'memory_write_failed',
            '暂时无法删除这项记忆，请稍后再试。',
            { retryable: true },
          )
        }
      }
    }
    await this.sendOutput(callId, output, turnId)
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
