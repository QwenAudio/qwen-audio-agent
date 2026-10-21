import { createHash } from 'node:crypto'
import { PERMISSION_DECISIONS } from '../../../../shared/permission-decisions.mjs'
import { inputPartRef } from '../../../../shared/input-parts.mjs'
import { isTaskCancellable } from '../../task/task-state.mjs'
import { toolFailure as failure } from './tool-result.mjs'

const CANCEL_RECEIPT_INSTRUCTIONS = [
  '根据本次响应中的全部取消结果，只作一次简短自然的确认。',
  '不要逐项复述 task_id，不要再次查询或取消，不要调用其他工具。',
].join(' ')

const STATUS_RESULT_MESSAGE = '请根据这次查询结果自然回答用户；不要再次调用状态工具，不要展示 task_id。'
const WORK_ACCEPTED_MESSAGE = '请求已受理，执行结果另行返回。本次只需自然确认受理。'
const WORK_DUPLICATE_MESSAGE = '请求此前已受理。本次只需自然确认受理。'

// Frontend handlers can be replaced on reconnect while their Tasks keep
// running. Keep bounded tool receipts with that TaskManager's lifetime.
const updateReceiptsByTaskManager = new WeakMap()

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
    const manager = host.taskOperations?.taskManager || host.taskManager || host.taskOperations || host
    if (!updateReceiptsByTaskManager.has(manager)) updateReceiptsByTaskManager.set(manager, new Map())
    this.updateResponses = updateReceiptsByTaskManager.get(manager)
  }

  pendingPermissions() {
    const permissions = this.host.taskOperations.pendingPermissions(this.host)
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

  createWork({ turnId, ...input }) {
    return this.host.taskOperations.submit(input, {
      ownerId: this.host.ownerId, sessionId: this.host.sessionId, turnId,
    })
  }

  async executeUpdateToolCall({ callId, turnId, args, event, callContext = {} }) {
    const responseId = String(callContext.responseId || event?.response_id || '')
    const key = JSON.stringify([this.host.ownerId, this.host.sessionId, turnId || callId, args.task_id])
    const previous = this.updateResponses.get(key)
    let receipt
    try {
      // Keep the accepted receipt even after a pending input is resolved. A
      // repeated answer must not fall through into steering or restart work.
      if (previous) {
        const prior = await previous
        receipt = {
          ...prior,
          status: 'duplicate',
          message: prior.input_request_id
            ? '回答此前已受理，不代表操作已批准或执行完成。本次只需自然确认受理。'
            : WORK_DUPLICATE_MESSAGE,
        }
      } else {
        const pending = this.applyTaskUpdate({ callId, turnId, args })
        this.updateResponses.set(key, pending)
        if (this.updateResponses.size > 200) this.updateResponses.delete(this.updateResponses.keys().next().value)
        receipt = await pending
      }
    } catch (error) {
      if (!previous) this.updateResponses.delete(key)
      await this.host.sendOutput(callId, failure(
        error.code || 'work_update_failed', error.message, { retryable: false },
      ), turnId, args.task_id)
      return
    }
    if (previous) this.host.markTerminalToolResponse(responseId)
    await this.host.sendOutput(callId, receipt, turnId, args.task_id,
      previous ? { createResponse: false } : undefined)
  }

  async applyTaskUpdate({ callId, turnId, args }) {
    const instruction = typeof args.instruction === 'string' ? args.instruction.trim() : ''
    if (!instruction || instruction.length > 16_000) {
      throw Object.assign(new Error('补充要求或回答不能为空或超过 16000 字符。'), { code: 'invalid_instruction' })
    }
    const task = this.host.taskOperations.get(args.task_id, this.host)
    const request = task?.inputRequest
    if (request?.status === 'pending'
      || args.input_request_id !== undefined || args.values !== undefined) {
      return this.replyToTaskInput(task, request, { ...args, instruction }, turnId)
    }
    const inputParts = mergeInputParts(
      this.host.transcripts.parts(turnId),
      this.host.inputAssets?.resolve({
        ownerId: this.host.ownerId, sessionId: this.host.sessionId, refs: args.input_refs,
      }) || [],
    )
    const receipt = this.host.taskOperations.update({
      taskId: args.task_id, instruction, inputParts,
      submissionKey: JSON.stringify(['update', this.host.sessionId, turnId || callId, args.task_id]),
    }, this.host)
    return {
      status: receipt.status, task_id: receipt.taskId,
      message: receipt.status === 'duplicate' ? WORK_DUPLICATE_MESSAGE : WORK_ACCEPTED_MESSAGE,
    }
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
    // A pending request belongs to its Task, not the entire conversation.
    // Independent work can use another execution slot without approving or
    // resolving that request. Replies use the explicit update/permission tools.
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
      const existing = this.host.taskOperations.list({
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
              message: WORK_DUPLICATE_MESSAGE,
            }
          : {
              status: 'accepted',
              task_id: task.id,
              message: WORK_ACCEPTED_MESSAGE,
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
      if (this.host.answersRequest?.(turnId, authorizationId) === false) {
        await this.host.sendOutput(callId, failure(
          'permission_not_answered', '用户还没有回答这个权限请求；请求仍待确认。', { retryable: false },
        ), turnId, null, responseOptions('用户还没有回答这个权限请求。不要代替用户决定，简短询问是否允许，不要调用工具。'))
        return
      }
      if (!this.host.taskOperations.respondAuthorization) {
        await this.host.sendOutput(
          callId,
          failure('permission_unavailable', '当前后台无法接收权限决定。'),
          turnId,
          null,
          responseOptions('当前后台无法接收权限决定。简短说明授权没有生效，不要声称操作已经执行，也不要调用工具。'),
        )
        return
      }
      const admission = this.host.taskOperations.submitPermission(
        authorizationId, decision, this.host, {
          onFailure: ({ permissionId, taskId, decision, error }) => {
            this.host.submittedBackendPermissions.delete(permissionId)
            this.permissionReceipts.delete(permissionId)
            this.host.onPermissionDeliveryFailed({
              authorizationId: permissionId, taskId, decision,
              error: String(error?.message || error),
            })
          },
        },
      )
      for (const id of admission.permissionIds) {
        this.host.submittedBackendPermissions.add(id)
        this.rememberPermissionReceipt(id, {
          permissionId: id, taskId: admission.taskId, decision: admission.decision, turnId,
        })
      }
      // Voice confirms local acceptance without blocking on the backend. Client
      // commands await their request's acknowledgement before replying to the card.
      admission.completion.catch(() => {}).finally(() => {
        for (const id of admission.permissionIds) this.host.submittedBackendPermissions.delete(id)
      })
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

  async replyToTaskInput(task, request, args, turnId) {
    const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }
    if (
      !task
      || task.sessionId !== this.host.sessionId
      || request?.status !== 'pending'
      || (args.input_request_id !== undefined && args.input_request_id !== request.id)
    ) {
      fail('input_not_pending', '对应的后台问题已失效或不在当前会话，回答没有提交。')
    }
    if (this.host.answersRequest?.(turnId, request.id) === false) {
      fail('input_not_answered', '用户还没有回答这个后台问题；请先向用户转述问题。')
    }
    if (!this.host.taskOperations.respondInput) {
      fail('input_unavailable', '当前后台无法接收补充输入。')
    }
    if (args.values !== undefined && (!args.values || typeof args.values !== 'object' || Array.isArray(args.values))) {
      fail('invalid_input_values', '表单回答必须是对象。')
    }
    if (args.input_refs?.length || this.host.transcripts.parts(turnId)?.some(part => part?.type === 'file')) {
      fail('input_attachments_unsupported', '当前后台追问仅支持文本或表单回答，尚未提交附件。')
    }
    // Deliver the user's answer, not an inferred approval. Its business meaning
    // belongs to the backend holding the original question or operation preview.
    await this.host.taskOperations.respondToInput(task.id, request.id, {
      text: args.instruction,
      values: args.values,
    }, this.host)
    return {
      status: 'accepted',
      task_id: task.id,
      input_request_id: request.id,
      message: '回答已交回原来的工作，不代表操作已批准或执行完成。本次只需自然确认受理。',
    }
  }

  async cancelAgentTask(callId, turnId, args, responseOptions) {
    const reachable = task => !this.host.startedLater?.(task.turnId, turnId)
    if (args.all === true) {
      const targets = this.host.taskOperations.list({
        ownerId: this.host.ownerId,
        sessionId: this.host.sessionId,
      }).filter(task => isTaskCancellable(task.status) && reachable(task))
      if (!targets.length) {
        await this.host.sendOutput(callId, {
          status: 'not_found',
          message: '当前没有仍在排队或执行的工作。',
        }, turnId, null, responseOptions)
        return
      }
      const results = await Promise.all(targets.map(target => (
        this.host.taskOperations.cancel(target.id, { ownerId: this.host.ownerId })
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
      const existing = this.host.taskOperations.list({ ownerId: this.host.ownerId })
        .filter(task => task.seriesId === requestedSeriesId)
      if (!existing.length) {
        await this.host.sendOutput(callId, {
          status: 'not_found',
          series_id: requestedSeriesId,
          message: '没有找到这组循环提醒。',
        }, turnId, null, responseOptions)
        return
      }
      const results = await this.host.taskOperations.cancelSeries(requestedSeriesId, {
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
      ? this.host.taskOperations.get(requestedTaskId, { ownerId: this.host.ownerId })
      : this.host.taskOperations.list({
        ownerId: this.host.ownerId,
        sessionId: this.host.sessionId,
        }).find(task => isTaskCancellable(task.status) && reachable(task))
    if (!target || !reachable(target)) {
      await this.host.sendOutput(callId, {
        status: 'not_found',
        message: '当前没有仍在排队或执行的工作。',
      }, turnId, null, responseOptions)
      return
    }
    const task = await this.host.taskOperations.cancel(target.id, {
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
      const tasks = this.host.taskOperations.list({
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
    const sessionTasks = this.host.taskOperations.list({
      ownerId: this.host.ownerId,
      sessionId: this.host.sessionId,
    })
    const task = requestedTaskId
      ? this.host.taskOperations.get(requestedTaskId, { ownerId: this.host.ownerId })
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
      ...(task.updates?.length ? { instruction_updates: task.updates.slice(-5) } : {}),
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
