import {
  CANCEL_AGENT_TASK_TOOL_NAME,
  RESPOND_PERMISSION_TOOL_NAME,
  SPAWN_THINKING_TOOL_NAME,
  UPDATE_AGENT_TASK_TOOL_NAME,
  frontendToolRegistry,
} from '../frontend-tools.mjs'
import { buildFrontendToolContext } from './frontend-tool-context.mjs'
import { optionalFrontendFeatures } from '../optional-features.mjs'
import { agentTaskToolHandlers } from './features/agent-task-tools.mjs'
import { coreToolHandlers } from './features/core-tools.mjs'
import { personalToolHandlers } from './features/personal-tools.mjs'
import { retrievalToolHandlers } from './features/retrieval-tools.mjs'
import { scheduleToolHandlers } from './features/schedule-tools.mjs'
import { AgentTaskRuntime } from './agent-task-runtime.mjs'
import { TaskOperations } from '../../orchestration/task-operations.mjs'
import { isTaskTerminal } from '../../task/task-state.mjs'
import {
  findFrontendSourceTool,
} from './frontend-tool-source.mjs'
import {
  boundFrontendToolResult,
  FrontendToolLoop,
} from './frontend-tool-loop.mjs'

const MAX_DEBUG_RESULT_CHARS = 180

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

function compactDebugValue(value, maxChars = MAX_DEBUG_RESULT_CHARS) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return [...text].slice(0, maxChars).join('')
}

function compactDebugResult(output) {
  if (typeof output === 'string') return compactDebugValue(output)
  if (!output || typeof output !== 'object') return compactDebugValue(output)
  return compactDebugValue(
    output.user_message
    || output.message
    || output.content
    || output.status
    || output.error_code
    || JSON.stringify(output),
  )
}

function debugSurface(toolName) {
  return toolName === SPAWN_THINKING_TOOL_NAME ? 'backend' : 'frontend'
}

function needsToolResultSummary(toolName, args) {
  // Memory writes and lifecycle receipts may accompany an already-spoken
  // answer. Ordinary reads/actions need their actual result even in that case.
  for (const feature of optionalFrontendFeatures) {
    const required = feature.requiresToolResultSummary?.(toolName, args)
    if (typeof required === 'boolean') return required
  }
  return ![
    SPAWN_THINKING_TOOL_NAME,
    UPDATE_AGENT_TASK_TOOL_NAME,
    RESPOND_PERMISSION_TOOL_NAME,
    CANCEL_AGENT_TASK_TOOL_NAME,
  ].includes(toolName)
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
    taskOperations,
    backendAvailability = null,
    memoryService,
    notesStore,
    getClientContext = () => ({}),
    onMemoryChanged = () => {},
    respondAuthorization,
    respondInput,
    permissionPolicy,
    onPermissionDeliveryFailed = () => {},
    onToolResultReady = () => {},
    onToolResponseFailed = () => {},
    onToolCallDebug = () => {},
    onAgentActivity = () => {},
    inputAssets = null,
    frontendRetrieval = null,
    frontendKnowledge = null,
    disabledTools = [],
    frontendToolSources = [],
    externalToolContext = {},
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
    this.taskOperations = taskOperations || (taskManager ? new TaskOperations({
      taskManager, backendRuntime, respondAuthorization, respondInput, permissionPolicy,
    }) : null)
    this.backendAvailability = backendAvailability
    this.memoryService = memoryService
    this.notesStore = notesStore
    this.getClientContext = getClientContext
    this.onMemoryChanged = onMemoryChanged
    this.onPermissionDeliveryFailed = onPermissionDeliveryFailed
    this.onToolResultReady = onToolResultReady
    this.onToolResponseFailed = onToolResponseFailed
    this.onToolCallDebug = onToolCallDebug
    this.onAgentActivity = onAgentActivity
    this.inputAssets = inputAssets
    this.frontendRetrieval = frontendRetrieval
    this.frontendKnowledge = frontendKnowledge
    this.disabledTools = [...disabledTools]
    this.frontendToolSources = frontendToolSources
    this.externalToolContext = externalToolContext
    this.turnCitations = turnCitations
    this.agentTaskRuntime = new AgentTaskRuntime(this)
    this.activeToolEntries = new Map()
    this.activeToolDebugEntries = new Map()
    this.externalToolLoop = new FrontendToolLoop()
    this.sessionDigests = sessionDigests
    this.toolExecutor = frontendToolRegistry.createExecutor({
      ...agentTaskToolHandlers(this),
      ...scheduleToolHandlers(this),
      ...coreToolHandlers(this),
      ...personalToolHandlers(this),
      ...retrievalToolHandlers(this),
      ...Object.assign({}, ...optionalFrontendFeatures.map(feature => feature.handlers(this))),
    })
    this.processedCalls = new Set()
    this.spawnResponseByTurn = new Map()
    this.statusResponseByTurn = new Map()
    this.cancelResponseByTurn = new Map()
    this.terminalToolResponses = new Set()
    this.stoppedToolTurns = new Map()
    this.deferredToolResponses = new Map()
    this.submittedBackendPermissions = new Set()
  }

  externalTool(name) {
    return findFrontendSourceTool(this.frontendToolSources, name)
  }

  emitToolCallDebug(event) {
    try {
      this.onToolCallDebug(event)
    } catch {
      // Debug hooks must never affect user-visible tool handling.
    }
  }

  hasPendingBackendPermission() {
    return (this.taskOperations?.pendingPermissions(this).size || 0) > 0
  }

  hasPendingBackendInput() {
    if (!this.taskManager?.list) return false
    return this.taskManager.list({
      ownerId: this.ownerId,
      sessionId: this.sessionId,
      active: true,
    }).some(task => task.inputRequest?.status === 'pending')
  }

  async executeExternalSource(external, args, context = {}) {
    const { source, tool } = external
    let output
    try {
      output = await source.execute(tool.name, args, {
        ...this.externalToolContext,
        turnId: context.turnId,
        isCurrent: () => !this.isStale(context.turnId, context.turnGeneration),
      })
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
      await this.stopToolLoop(context, limit.reason)
      return { handled: true, executed: false, limit }
    }
    const output = await this.executeExternalSource(external, context.args, context)
    const silent = tool.policy?.responseOnSuccess === 'none' && output?.error !== true && output?.isError !== true
    await this.sendOutput(context.callId, output, context.turnId, null,
      tool.policy?.responseOnSuccess === 'none' ? { createResponse: !silent } : undefined)
    return { handled: true, executed: true, value: output }
  }

  toolTurnKey(turnId, turnGeneration) {
    return JSON.stringify([turnId, turnGeneration])
  }

  async stopToolLoop({ callId, turnId, turnGeneration }, reason) {
    const key = this.toolTurnKey(turnId, turnGeneration)
    const responseId = this.activeToolDebugEntries.get(callId)?.responseId || ''
    const responseKey = responseId || callId
    const stopped = this.stoppedToolTurns.has(key)
    if (!stopped) {
      if (this.stoppedToolTurns.size >= 100) {
        this.stoppedToolTurns.delete(this.stoppedToolTurns.keys().next().value)
      }
      this.stoppedToolTurns.set(key, responseKey)
    } else if (this.stoppedToolTurns.get(key) !== responseKey) {
      this.markTerminalToolResponse(responseId)
    }
    // Admission only proves an earlier attempt, not success. Preserve the
    // original result in context and request one final explanation, rather
    // than claiming the operation completed or silently ending the turn.
    await this.sendOutput(callId, failure(
      reason === 'repeated_call' ? 'repeated_tool_call'
        : reason === 'stopped' ? 'tool_loop_stopped' : 'tool_loop_limit',
      reason === 'repeated_call'
        ? '本轮相同调用已尝试，本次未再次执行。请根据已有工具结果说明实际结果或失败原因，不再调用工具。'
        : '本轮已停止继续调用工具。请根据已有工具结果说明已完成和未完成的部分，不再调用工具。',
      { status: 'blocked' },
    ), turnId, null, {
      createResponse: !stopped,
      ...(!stopped ? { response: { tool_choice: 'none' } } : {}),
    })
  }

  async respondPermission(context) {
    return this.respondAgentPermission(context)
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
    // A full-duplex frontend keeps its backend working while the user speaks,
    // so its tool calls are never superseded by a new user turn.
    if (this.getFrontend?.()?.capabilities?.concurrentVoicePlayback) return false
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
    const debug = this.activeToolDebugEntries.get(callId)
    const batch = this.deferredToolResponses.get(debug?.responseId)
    // A successful in-progress receipt becomes obsolete once that work ends.
    // Keep the tool output in model context, but do not speak its stale summary.
    const task = taskId ? this.taskOperations?.get(taskId, { ownerId: this.ownerId }) : null
    const progressReceipt = task && !output?.error && !output?.isError && (
      ['accepted', 'duplicate', 'submitted'].includes(output?.status)
      || !isTaskTerminal(output?.task_status || task.status)
    )
    const isCurrent = progressReceipt
      ? () => {
          const current = this.taskOperations?.get(taskId, { ownerId: this.ownerId })
          return Boolean(current && !isTaskTerminal(current.status))
        }
      : () => true
    const toolTurnKey = this.toolTurnKey(turnId, batch?.turnGeneration ?? this.getTurnGeneration())
    const mayRespond = () => isCurrent() && (
      !this.stoppedToolTurns.has(toolTurnKey)
      || this.stoppedToolTurns.get(toolTurnKey) === (debug?.responseId || callId)
    )
    if (batch) batch.responseGuards.push(mayRespond)
    else frontendOptions.shouldRespond = mayRespond
    if (batch && frontendOptions.createResponse !== false) {
      // Return every result first. One response may contain several concurrent
      // calls, including a mix of built-in and external tools.
      batch.responseRequested = true
      batch.requiresResultSummary = true
      Object.assign(batch.responseContext, taskId ? { taskId } : {}, responseContext)
      if (responseContext?.consumesTaskNotification && taskId && !batch.taskIds.includes(taskId)) {
        batch.taskIds.push(taskId)
      }
      this.addDeferredToolResponseInstructions(
        debug.responseId,
        frontendOptions.response?.instructions,
      )
      batch.disableTools ||= frontendOptions.response?.tool_choice === 'none'
      frontendOptions.createResponse = false
    }
    try {
      this.onToolResultReady({
        callId,
        turnId,
        toolName: tool?.name || '',
        failed: output?.error === true || output?.isError === true,
        ...(typeof output?.error_code === 'string' ? { errorCode: output.error_code } : {}),
        ...(taskId ? { taskId } : {}),
      })
    } catch {
      // Observability hooks must never affect tool execution or delivery.
    }
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
    if (debug) {
      this.emitToolCallDebug({
        ...debug,
        status: safeOutput?.error ? 'failed' : 'completed',
        result: compactDebugResult(projectedOutput),
        durationMs: Math.max(0, Date.now() - debug.startedAt),
        ...(taskId ? { taskId } : {}),
      })
    }
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
    requestResponse = true,
    requiresResultSummary = false,
  } = {}, response = null) {
    const key = String(responseId || '')
    if (!key) return null
    const batch = this.deferredToolResponses.get(key) || {
      pending: 0,
      sourceDone: false,
      failed: false,
      suppressResponse: false,
      sourceHasSpeech: false,
      responseRequested: false,
      disableTools: false,
      requiresResultSummary: false,
      turnId,
      turnGeneration,
      responseInstructions: [],
      responseGuards: [],
      responseContext: {},
      taskIds: [],
    }
    if (!this.deferredToolResponses.has(key) && this.deferredToolResponses.size >= 100) {
      this.deferredToolResponses.delete(this.deferredToolResponses.keys().next().value)
    }
    batch.pending += 1
    batch.responseRequested ||= requestResponse
    batch.requiresResultSummary ||= requiresResultSummary
    batch.disableTools ||= response?.tool_choice === 'none'
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

  requiresToolResultSummary(responseId) {
    const batch = this.deferredToolResponses.get(String(responseId || ''))
    return batch?.requiresResultSummary === true
  }

  async finishToolResponse(responseId, {
    suppressResponse = false,
    sourceHasSpeech = false,
  } = {}) {
    const key = String(responseId || '')
    const batch = this.deferredToolResponses.get(key)
    if (!batch) return
    batch.sourceDone = true
    batch.suppressResponse ||= suppressResponse
    batch.sourceHasSpeech ||= sourceHasSpeech
    await this.flushDeferredToolResponse(key, batch)
  }

  async flushDeferredToolResponse(responseId, batch) {
    if (!batch.sourceDone || batch.pending > 0) return
    this.deferredToolResponses.delete(responseId)
    if (batch.failed) {
      this.onToolResponseFailed({ responseId, turnId: batch.turnId })
      return
    }
    if (
      batch.suppressResponse || !batch.responseRequested
      || (batch.sourceHasSpeech && !batch.requiresResultSummary)
      || this.isStale(batch.turnId, batch.turnGeneration)
    ) return
    const instructions = [...batch.responseInstructions]
    if (batch.requiresResultSummary && instructions.length) {
      instructions.push(
        '以上针对单项工具的回执说明仅约束该工具；请将本次响应中全部工具的实际结果合并回复，不要遗漏其他工具的成功或失败，也不要把后台受理说成任务已完成。',
      )
    }
    try {
      await this.getFrontend()?.ensureResponse?.(
        {
          turnId: batch.turnId,
          turnGeneration: batch.turnGeneration,
          ...batch.responseContext,
          ...(batch.taskIds.length ? {
            taskId: batch.taskIds[0],
            taskIds: batch.taskIds,
          } : {}),
        },
        {
          afterToolResults: true,
          shouldCreate: () => !this.isStale(batch.turnId, batch.turnGeneration)
            && (!batch.responseGuards.length || batch.responseGuards.some(check => check())),
          ...(instructions.length || batch.disableTools ? {
            response: {
              ...(instructions.length ? { instructions: instructions.join(' ') } : {}),
              ...(batch.disableTools ? { tool_choice: 'none' } : {}),
            },
          } : {}),
        },
      )
    } catch (error) {
      this.onToolResponseFailed({ responseId, turnId: batch.turnId })
      throw error
    }
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

  createWork(...args) {
    return this.agentTaskRuntime.createWork(...args)
  }

  executeCancelToolCall(...args) {
    return this.agentTaskRuntime.executeCancelToolCall(...args)
  }

  executeStatusToolCall(...args) {
    return this.agentTaskRuntime.executeStatusToolCall(...args)
  }

  executeSpawnThinkingToolCall(...args) {
    return this.agentTaskRuntime.executeSpawnThinkingToolCall(...args)
  }

  executeUpdateToolCall(...args) {
    return this.agentTaskRuntime.executeUpdateToolCall(...args)
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
    let invalidArguments = false
    try {
      const parsed = JSON.parse(event.arguments === undefined ? '{}' : event.arguments)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        invalidArguments = true
      } else {
        args = parsed
      }
    } catch {
      invalidArguments = true
    }

    if (this.isStale(turnId, generation)) {
      await this.closeStaleCall(callId, turnId)
      return
    }

    const external = this.externalTool(toolName)
    const tool = frontendToolRegistry.get(toolName) || external?.tool
    if (tool) this.activeToolEntries.set(callId, tool)
    const responseId = String(callContext.responseId || event.response_id || '').trim()
    const debug = {
      callId,
      turnId,
      responseId,
      name: toolName,
      surface: debugSurface(toolName),
      status: 'received',
      arguments: args,
      startedAt: Date.now(),
    }
    this.activeToolDebugEntries.set(callId, debug)
    this.emitToolCallDebug(debug)
    // Register before any asynchronous execution, so response.done cannot
    // close a batch while another call is still preparing its result.
    const deferred = this.beginDeferredToolResponse(responseId, {
      turnId,
      turnGeneration: generation,
      requestResponse: false,
      requiresResultSummary: tool?.policy?.responseOnSuccess !== 'none' && needsToolResultSummary(toolName, args),
    })
    let failed = false
    try {
      if (invalidArguments) {
        const output = failure('invalid_arguments', '工具参数必须是有效的 JSON 对象。')
        await this.sendOutput(callId, output, turnId)
        return { handled: true, executed: false, value: output }
      }
      if (this.stoppedToolTurns.has(this.toolTurnKey(turnId, generation))) {
        await this.stopToolLoop({ callId, turnId, turnGeneration: generation }, 'stopped')
        return { handled: true, executed: false, limit: { admitted: false, reason: 'stopped' } }
      }
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
        turnGeneration: generation,
        args,
        event,
        callContext,
        frontend: buildFrontendToolContext({
          disabledTools: this.disabledTools,
          backendAvailability: this.backendAvailability,
          frontendRetrieval: this.frontendRetrieval,
          frontendKnowledge: this.frontendKnowledge,
          memoryService: this.memoryService,
          sessionDigests: this.sessionDigests,
          permissionPending: this.hasPendingBackendPermission() || (
            toolName === RESPOND_PERMISSION_TOOL_NAME
            && Boolean(this.agentTaskRuntime.permissionReceipt(args.permission_id, turnId))
          ),
          inputPending: this.hasPendingBackendInput(),
        }),
      })
      if (execution.handled && !execution.executed) {
        if (execution.limit.reason === 'tool_unavailable') {
          await this.sendOutput(callId, failure(
            'tool_unavailable', '当前前台没有启用这个能力。',
          ), turnId)
        } else {
          await this.stopToolLoop(
            { callId, turnId, turnGeneration: generation }, execution.limit.reason,
          )
        }
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
    } catch (error) {
      failed = true
      throw error
    } finally {
      this.activeToolEntries.delete(callId)
      this.activeToolDebugEntries.delete(callId)
      await this.completeDeferredToolResponse(deferred, { failed })
    }
  }

  respondAgentPermission(...args) {
    return this.agentTaskRuntime.respondAgentPermission(...args)
  }

  cancelAgentTask(...args) {
    return this.agentTaskRuntime.cancelAgentTask(...args)
  }

  getAgentTaskStatus(...args) {
    return this.agentTaskRuntime.getAgentTaskStatus(...args)
  }

}
