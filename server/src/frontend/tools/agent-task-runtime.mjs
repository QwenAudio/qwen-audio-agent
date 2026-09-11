import { createHash } from 'node:crypto'
import { PERMISSION_DECISIONS, backendPermissionDecision } from '../../../../shared/permission-decisions.mjs'
import { inputPartRef } from '../../../../shared/input-parts.mjs'
import { BackendEventType } from '../../core/backend-events.mjs'
import { isTaskCancellable } from '../../task/task-state.mjs'
import { toolFailure as failure } from './tool-result.mjs'

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

export class AgentTaskRuntime {
  constructor(host) {
    this.host = host
    this.permissionReceipts = new Map()
  }

  pendingPermissions() {
    const tasks = new Map(this.host.taskManager.list({
      ownerId: this.host.ownerId,
      sessionId: this.host.sessionId,
      active: true,
    }).filter(task => task.status !== 'cancelling').map(task => [task.id, task]))
    const permissions = new Map()
    for (const [id, entry] of this.host.pendingBackendPermissions) {
      const task = tasks.get(entry.taskId)
      if (task && entry.permission.status === 'pending') {
        permissions.set(id, { task, permission: entry.permission })
      }
    }
    // A reconnected frontend may not have observed the original backend event.
    for (const task of tasks.values()) {
      if (task.authorization?.status === 'pending') {
        permissions.set(task.authorization.id, { task, permission: task.authorization })
      }
    }
    for (const id of this.host.submittedBackendPermissions) permissions.delete(id)
    return permissions
  }

  rememberPermissionReceipt(id, receipt) {
    this.permissionReceipts.set(id, receipt)
    while (this.permissionReceipts.size > 200) {
      this.permissionReceipts.delete(this.permissionReceipts.keys().next().value)
    }
  }

  permissionReceipt(permissionId, turnId) {
    const id = String(permissionId || '').trim()
    if (id) return this.permissionReceipts.get(id)
    const sameTurn = [...this.permissionReceipts.values()].find(item => item.turnId === turnId)
    if (sameTurn) return sameTurn
    // While the backend is still acknowledging the sole submitted decision,
    // another user confirmation can read that receipt, not report it missing.
    if (this.host.submittedBackendPermissions.size === 1 && this.pendingPermissions().size === 0) {
      return this.permissionReceipts.get(this.host.submittedBackendPermissions.values().next().value)
    }
    return undefined
  }

  forwardBackendEvent(taskId, event, onEvent) {
    const publish = event => {
      const permission = event?.permission
      if (event?.type === BackendEventType.AUTHORIZATION_RESOLVED && permission?.id) {
        this.host.pendingBackendPermissions.delete(permission.id)
        this.host.submittedBackendPermissions.delete(permission.id)
      }
      if (
        event?.type === BackendEventType.AUTHORIZATION_REQUESTED
        && permission?.id
      ) {
        this.host.pendingBackendPermissions.set(permission.id, {
          taskId,
          permission,
        })
      }
      onEvent(event)
    }
    if (this.host.permissionPolicy) {
      this.host.permissionPolicy.forwardBackendEvent({
        taskId, ownerId: this.host.ownerId, sessionId: this.host.sessionId,
      }, event, publish, this.host.respondAuthorization)
    } else {
      publish(event)
    }
  }

  createWork({
    turnId,
    objective,
    submissionKey,
    inputParts = [],
  }) {
    let taskId = ''
    const task = this.host.taskManager.create({
      objective,
      ownerId: this.host.ownerId,
      sessionId: this.host.sessionId,
      turnId,
      submissionKey,
      laneKey: `backend:${this.host.ownerId}`,
      laneLimit: 1,
      runner: async (_ignored, { onEvent, signal }) => {
        try {
          return await this.host.backendRuntime.run({
            objective,
            inputParts,
          }, {
            ownerId: this.host.ownerId,
            sessionId: this.host.sessionId,
            turnId,
            taskId,
            signal,
            onEvent: event => this.host.forwardBackendEvent(taskId, event, onEvent),
          })
        } finally {
          for (const [id, entry] of this.host.pendingBackendPermissions) {
            if (entry.taskId !== taskId) continue
            this.host.pendingBackendPermissions.delete(id)
            this.host.submittedBackendPermissions.delete(id)
          }
        }
      },
      canceler: async ({ previousStatus, abort }) => {
        const result = await this.host.backendRuntime.cancel(
          taskId,
          { ownerId: this.host.ownerId },
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
      ? this.host.cancelResponseByTurn.get(turnId)
      : null
    if (responseId && firstCancelResponse
      && firstCancelResponse !== responseId) {
      this.host.markTerminalToolResponse(responseId)
      await this.host.sendOutput(callId, {
        status: 'duplicate',
        message: '本轮取消操作已经处理，不再重复执行。',
      }, turnId, null, { createResponse: false })
      return
    }
    if (responseId && turnId && !firstCancelResponse) {
      this.host.cancelResponseByTurn.set(turnId, responseId)
      if (this.host.cancelResponseByTurn.size > 100) {
        this.host.cancelResponseByTurn.delete(
          this.host.cancelResponseByTurn.keys().next().value,
        )
      }
    }
    const deferred = this.host.beginDeferredToolResponse(responseId, {
      turnId,
      turnGeneration: generation,
    }, { instructions: CANCEL_RECEIPT_INSTRUCTIONS })
    let outputFailed = false
    try {
      await this.host.cancelAgentTask(
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
      await this.host.completeDeferredToolResponse(deferred, {
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
      ? this.host.spawnResponseByTurn.get(turnId)
      : null
    const firstStatusResponse = turnId
      ? this.host.statusResponseByTurn.get(turnId)
      : null
    const followsSpawnReceipt = Boolean(
      responseId && spawnResponse && responseId !== spawnResponse,
    )
    const repeatsStatusQuery = Boolean(
      responseId && firstStatusResponse && responseId !== firstStatusResponse,
    )
    if (followsSpawnReceipt || repeatsStatusQuery) {
      this.host.markTerminalToolResponse(responseId)
      await this.host.sendOutput(callId, {
        status: 'duplicate',
        message: '本轮不需要再次查询工作状态。',
      }, turnId, null, { createResponse: false })
      return
    }
    if (responseId && turnId && !firstStatusResponse) {
      this.host.statusResponseByTurn.set(turnId, responseId)
      if (this.host.statusResponseByTurn.size > 100) {
        this.host.statusResponseByTurn.delete(
          this.host.statusResponseByTurn.keys().next().value,
        )
      }
    }
    this.host.onAgentActivity({ activity: 'query', turnId })
    await this.host.getAgentTaskStatus(callId, turnId, args)
  }

  async executeSpawnThinkingToolCall({
    callId,
    turnId,
    generation,
    args,
    event,
    callContext,
  }) {
    const pendingPermissionTask = this.host.taskManager.list({
      ownerId: this.host.ownerId,
      sessionId: this.host.sessionId,
      active: true,
    }).find(task => task.authorization?.status === 'pending')
    if (pendingPermissionTask) {
      await this.host.sendOutput(
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
    const availability = this.host.backendAvailability?.snapshot()
      || { configured: true, ok: true, known: false }
    if (availability.configured === false) {
      await this.host.sendOutput(
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
      await this.host.sendOutput(
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
      const resolved = await this.host.transcripts.resolveDelegation(turnId, '')
      if (this.host.isStale(turnId, generation)) {
        await this.host.closeStaleCall(callId, turnId)
        return
      }
      objective = String(resolved.originalRequest || '').trim()
    }
    if (!objective) {
      await this.host.sendOutput(
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
      ? this.host.spawnResponseByTurn.get(turnId)
      : null
    if (responseId && firstSpawnResponse && firstSpawnResponse !== responseId) {
      this.host.markTerminalToolResponse(responseId)
      const existing = this.host.taskManager.list({
        ownerId: this.host.ownerId,
        sessionId: this.host.sessionId,
      }).find(item => item.turnId === turnId)
      await this.host.sendOutput(callId, {
        status: 'duplicate',
        ...(existing?.id ? { task_id: existing.id } : {}),
        message: '本轮工作已经提交，不再从工具回执继续创建任务。',
      }, turnId, existing?.id, { createResponse: false })
      return
    }
    if (responseId && turnId && !firstSpawnResponse) {
      this.host.spawnResponseByTurn.set(turnId, responseId)
      if (this.host.spawnResponseByTurn.size > 100) {
        this.host.spawnResponseByTurn.delete(
          this.host.spawnResponseByTurn.keys().next().value,
        )
      }
    }

    let task
    try {
      const historicalInputParts = this.host.inputAssets?.resolve({
        ownerId: this.host.ownerId,
        sessionId: this.host.sessionId,
        refs: args.input_refs,
      }) || []
      const delegatedInputParts = mergeInputParts(
        this.host.transcripts.parts(turnId),
        historicalInputParts,
      )
      const submissionKey = [
        'delegation',
        this.host.sessionId,
        turnId || callId,
        objectiveFingerprint(objective),
      ].join(':')
      task = this.host.createWork({
        turnId,
        objective,
        submissionKey,
        inputParts: delegatedInputParts,
      })
    } catch (error) {
      const message = String(error?.message || error || '')
      if (/输入.*失效|输入引用|找不到或无权访问/.test(message)) {
        await this.host.sendOutput(
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
      await this.host.sendOutput(
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
    const deferred = this.host.beginDeferredToolResponse(responseId, {
      turnId,
      turnGeneration: generation,
    })
    let outputFailed = false
    try {
      await this.host.sendOutput(
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
      await this.host.completeDeferredToolResponse(deferred, {
        failed: outputFailed,
      })
    }
  }

  async respondAgentPermission({
    callId,
    turnId,
    generation,
    args,
    callContext,
  }) {
    const requestedPermissionId = String(args.permission_id || '').trim()
    const decision = String(args.decision || '').trim()
    const responseId = String(
      callContext?.responseId || callContext?.event?.response_id || '',
    ).trim()
    const response = PERMISSION_DECISIONS.includes(decision)
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
                '该任务已获准继续执行，后续权限请求由网关自动处理。',
                '只用一句简短自然口语确认“已允许，后台继续执行”。',
                '不要重述操作，不要再次询问或调用工具。',
              ].join(' '),
        }
      : null
    const deferred = this.host.beginDeferredToolResponse(responseId, {
      turnId,
      turnGeneration: generation,
    })
    const responseOptions = instructions => {
      if (deferred) {
        this.host.addDeferredToolResponseInstructions(deferred, instructions)
        return { createResponse: false }
      }
      return { response: { instructions } }
    }
    const invalidPermissionInstructions = [
      '当前没有真实、仍待确认的后台权限请求，任何相关操作都没有因此获得授权或开始执行。',
      '简短说明这次授权没有生效，不要伪造权限请求、工作 ID 或执行状态，也不要调用工具。',
    ].join(' ')
    let failed = false
    const pending = this.pendingPermissions()
    try {
      const transcript = String(await this.host.transcripts.transcript(turnId)).trim()
      if (!response || !transcript) {
        await this.host.sendOutput(
          callId,
          failure('invalid_permission_response', '没有找到有效的权限请求或决定。'),
          turnId,
          null,
          responseOptions(invalidPermissionInstructions),
        )
        return
      }
      // An omitted ID binds to one request, not a queue-draining operation.
      // Repeated model calls in the same user turn reuse that receipt even if
      // the backend has since requested permission for its next operation.
      const receipt = this.permissionReceipt(requestedPermissionId, turnId)
      if (receipt) {
        await this.host.sendOutput(callId, {
          status: 'already_submitted',
          permission_id: receipt.permissionId,
          task_id: receipt.taskId,
          decision: receipt.decision,
        }, turnId, receipt.taskId, responseOptions(
          '该权限决定已提交。按回执中的实际决定回答，不要重复授权或声称工作已经完成。',
        ))
        return
      }
      if (!requestedPermissionId && pending.size > 1) {
        await this.host.sendOutput(callId, failure(
          'permission_ambiguous',
          '有多个待确认请求，请明确要处理哪一个。',
          { permissions: [...pending.values()].map(({ task, permission }) => ({
            permission_id: permission.id,
            task_id: task.id,
            operation: permission.summary,
          })) },
        ), turnId, null, responseOptions(
          '有多个待确认请求，尚未授权。请向用户确认要处理哪项操作，不要猜测。',
        ))
        return
      }
      const selected = requestedPermissionId
        ? pending.get(requestedPermissionId)
        : pending.values().next().value
      const pendingTask = selected?.task
      const authorizationId = selected?.permission.id
      // Never retarget an ID-less response if its original request disappeared
      // while waiting for the current turn's transcript.
      if (!pendingTask || !authorizationId || !this.pendingPermissions().has(authorizationId)) {
        await this.host.sendOutput(
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
      if (!this.host.respondAuthorization) {
        await this.host.sendOutput(
          callId,
          failure('permission_unavailable', '当前后台无法接收权限决定。'),
          turnId,
          null,
          responseOptions('当前后台无法接收权限决定。简短说明授权没有生效，不要声称操作已经执行，也不要调用工具。'),
        )
        return
      }
      const rollbackPermission = this.host.permissionPolicy?.applyDecision(
        this.host.ownerId,
        this.host.sessionId,
        decision,
        pendingTask.id,
      )
      // Receipt-based: the local policy takes effect immediately and the backend
      // round trip must not delay the spoken confirmation. Task approval also
      // settles permissions that arrived concurrently for this same task.
      const permissions = decision !== 'reject'
        ? [...this.host.pendingBackendPermissions.entries()]
            .filter(([id, entry]) => (
              entry.taskId === pendingTask.id
              && !this.host.submittedBackendPermissions.has(id)
            ))
            .map(([id, entry]) => ({ id, taskId: entry.taskId }))
        : [{ id: authorizationId, taskId: pendingTask.id }]
      if (!permissions.some(permission => permission.id === authorizationId)) {
        permissions.push({ id: authorizationId, taskId: pendingTask.id })
      }
      permissions.forEach(permission => {
        this.host.submittedBackendPermissions.add(permission.id)
        this.rememberPermissionReceipt(permission.id, {
          permissionId: permission.id,
          taskId: permission.taskId,
          decision,
          turnId,
        })
      })
      Promise.all(permissions.map(async permission => {
        try {
          await this.host.respondAuthorization(
            permission.taskId,
            permission.id,
            backendPermissionDecision(decision),
            { ownerId: this.host.ownerId },
          )
          this.host.permissionPolicy?.settle(permission.id)
        } catch (error) {
          this.host.submittedBackendPermissions.delete(permission.id)
          this.permissionReceipts.delete(permission.id)
          try {
            this.host.onPermissionDeliveryFailed({
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
      })).then(() => {
        this.host.permissionPolicy?.flushPending(this.host.ownerId, this.host.sessionId)
      }).catch(() => rollbackPermission?.())
      const outputOptions = responseOptions(response.instructions)
      await this.host.sendOutput(callId, {
        status: 'submitted',
        permission_id: authorizationId,
        task_id: pendingTask.id,
        decision,
      }, turnId, pendingTask.id, outputOptions)
    } catch (error) {
      failed = true
      throw error
    } finally {
      await this.host.completeDeferredToolResponse(deferred, { failed })
    }
  }

  async respondAgentInput({ callId, turnId, args }) {
    const taskId = String(args.task_id || '').trim()
    const action = ['accept', 'decline', 'cancel'].includes(args.action)
      ? args.action
      : ''
    const task = taskId ? this.host.taskManager.getByTaskId(taskId, {
      ownerId: this.host.ownerId,
    }) : null
    const request = task?.inputRequest
    if (
      !task
      || task.sessionId !== this.host.sessionId
      || request?.status !== 'pending'
      || !action
    ) {
      await this.host.sendOutput(callId, failure(
        'input_not_pending',
        '当前没有仍在等待回答的后台输入请求。',
      ), turnId, null, {
        response: { instructions: '简短说明这次回答没有提交成功，不要声称后台已经继续。' },
      })
      return
    }
    if (!this.host.respondInput) {
      await this.host.sendOutput(callId, failure(
        'input_unavailable',
        '当前后台无法接收补充输入。',
      ), turnId)
      return
    }
    await this.host.respondInput(task.id, request.id, {
      action,
      text: String(args.text || '').trim(),
      values: args.values,
    }, { ownerId: this.host.ownerId })
    await this.host.sendOutput(callId, {
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
      const targets = this.host.taskManager.list({
        ownerId: this.host.ownerId,
        sessionId: this.host.sessionId,
      }).filter(task => isTaskCancellable(task.status))
      if (!targets.length) {
        await this.host.sendOutput(callId, {
          status: 'not_found',
          message: '当前没有仍在排队或执行的工作。',
        }, turnId, null, responseOptions)
        return
      }
      const results = await Promise.all(targets.map(target => (
        this.host.taskManager.cancel(target.id, { ownerId: this.host.ownerId })
      )))
      const cancelledCount = results.filter(result => (
        result?.status === 'cancelled'
      )).length
      await this.host.sendOutput(callId, {
        status: cancelledCount === targets.length ? 'cancelled' : 'partial',
        cancelled_count: cancelledCount,
        requested_count: targets.length,
        message: cancelledCount === targets.length
          ? '当前会话中的全部工作都已取消。'
          : '已取消仍可取消的工作，其余工作已经结束。',
      }, turnId, null, responseOptions)
      return
    }
    const requestedSeriesId = String(args.series_id || '').trim()
    if (requestedSeriesId) {
      const existing = this.host.taskManager.list({ ownerId: this.host.ownerId })
        .filter(task => task.seriesId === requestedSeriesId)
      if (!existing.length) {
        await this.host.sendOutput(callId, {
          status: 'not_found',
          series_id: requestedSeriesId,
          message: '没有找到这组循环提醒。',
        }, turnId, null, responseOptions)
        return
      }
      const results = await this.host.taskManager.cancelSeries(requestedSeriesId, {
        ownerId: this.host.ownerId,
      })
      const cancelledCount = results.filter(result => (
        result?.status === 'cancelled'
      )).length
      const taskId = results[0]?.id || existing[0].id
      await this.host.sendOutput(callId, {
        status: cancelledCount ? 'cancelled' : 'not_active',
        series_id: requestedSeriesId,
        task_id: taskId,
        cancelled_count: cancelledCount,
        requested_count: existing.filter(task => isTaskCancellable(task.status)).length,
        message: cancelledCount
          ? '已停止这组循环提醒。'
          : '这组循环提醒已经结束，当前无法取消。',
      }, turnId, taskId, responseOptions)
      return
    }
    const requestedTaskId = String(args.task_id || '').trim()
    const target = requestedTaskId
      ? this.host.taskManager.getByTaskId(requestedTaskId, { ownerId: this.host.ownerId })
      : this.host.taskManager.list({
        ownerId: this.host.ownerId,
        sessionId: this.host.sessionId,
        }).find(task => isTaskCancellable(task.status))
    if (!target) {
      await this.host.sendOutput(callId, {
        status: 'not_found',
        message: '当前没有仍在排队或执行的工作。',
      }, turnId, null, responseOptions)
      return
    }
    const task = await this.host.taskManager.cancel(target.id, {
      ownerId: this.host.ownerId,
    })
    if (!task) {
      await this.host.sendOutput(callId, {
        status: 'not_active',
        task_id: target.id,
        message: '这项工作已经结束，当前无法取消。',
      }, turnId, null, responseOptions)
      return
    }
    await this.host.sendOutput(callId, task.status === 'cancelled' ? {
      status: task.status,
      task_id: task.id,
      ...(task.seriesId ? { series_id: task.seriesId } : {}),
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
      const tasks = this.host.taskManager.list({
        ownerId: this.host.ownerId,
      }).slice(0, 20).map(task => ({
        task_id: task.id,
        status: task.status,
        kind: task.kind,
        ...(task.seriesId ? { series_id: task.seriesId } : {}),
        objective: String(task.objective || '').slice(0, 300),
        execute_at: task.schedule?.at
          ? new Date(task.schedule.at).toISOString()
          : null,
        recurrence: task.schedule?.recurrence || null,
      }))
      await this.host.sendOutput(callId, {
        status: tasks.length ? 'ok' : 'empty',
        count: tasks.length,
        tasks,
        message: STATUS_RESULT_MESSAGE,
      }, turnId)
      return
    }
    const requestedTaskId = String(args.task_id || '').trim()
    const sessionTasks = this.host.taskManager.list({
      ownerId: this.host.ownerId,
      sessionId: this.host.sessionId,
    })
    const task = requestedTaskId
      ? this.host.taskManager.getByTaskId(requestedTaskId, { ownerId: this.host.ownerId })
      : sessionTasks.find(item => [
          'scheduled',
          'queued',
          'running',
          'delegated',
          'finalizing',
        ].includes(item.status)) || sessionTasks[0]
    if (!task) {
      await this.host.sendOutput(callId, {
        status: 'not_found',
        message: '还没有可查询的后台工作。',
      }, turnId)
      return
    }
    const consumesTaskNotification = (
      ['completed', 'failed'].includes(task.status)
      && ['pending', 'delivering'].includes(task.notificationStatus)
    )
    await this.host.sendOutput(callId, {
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
}
