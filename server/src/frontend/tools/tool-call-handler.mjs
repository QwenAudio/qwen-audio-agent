import {
  RESPOND_PERMISSION_TOOL_NAME,
  SPAWN_THINKING_TOOL_NAME,
  frontendToolRegistry,
} from '../frontend-tools.mjs'
import { buildFrontendToolContext } from './frontend-tool-context.mjs'
import { optionalFrontendFeatures } from '../optional-features.mjs'
import { agentTaskToolHandlers } from './features/agent-task-tools.mjs'
import { clientToolHandlers } from './features/client-tools.mjs'
import { coreToolHandlers } from './features/core-tools.mjs'
import { personalToolHandlers } from './features/personal-tools.mjs'
import { retrievalToolHandlers } from './features/retrieval-tools.mjs'
import { scheduleToolHandlers } from './features/schedule-tools.mjs'
import { AgentTaskRuntime } from './agent-task-runtime.mjs'
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
    onToolResultReady = () => {},
    onToolCallDebug = () => {},
    presenceController = null,
    onAgentActivity = () => {},
    inputAssets = null,
    frontendRetrieval = null,
    frontendKnowledge = null,
    disabledTools = [],
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
    this.onToolResultReady = onToolResultReady
    this.onToolCallDebug = onToolCallDebug
    this.presenceController = presenceController
    this.onAgentActivity = onAgentActivity
    this.inputAssets = inputAssets
    this.frontendRetrieval = frontendRetrieval
    this.frontendKnowledge = frontendKnowledge
    this.disabledTools = [...disabledTools]
    this.frontendToolSources = frontendToolSources
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
      ...clientToolHandlers(this),
      ...Object.assign({}, ...optionalFrontendFeatures.map(feature => feature.handlers(this))),
    })
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

  emitToolCallDebug(event) {
    try {
      this.onToolCallDebug(event)
    } catch {
      // Debug hooks must never affect user-visible tool handling.
    }
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
    try {
      this.onToolResultReady({
        callId,
        turnId,
        toolName: tool?.name || '',
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

  forwardBackendEvent(...args) {
    return this.agentTaskRuntime.forwardBackendEvent(...args)
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
      this.activeToolDebugEntries.delete(callId)
    }
  }

  respondAgentPermission(...args) {
    return this.agentTaskRuntime.respondAgentPermission(...args)
  }

  respondAgentInput(...args) {
    return this.agentTaskRuntime.respondAgentInput(...args)
  }

  cancelAgentTask(...args) {
    return this.agentTaskRuntime.cancelAgentTask(...args)
  }

  getAgentTaskStatus(...args) {
    return this.agentTaskRuntime.getAgentTaskStatus(...args)
  }

}
