import { randomUUID } from 'node:crypto'
import { AgentError } from '../../agent-error.mjs'
import { BackendEventType, backendEvent } from '../../../core/backend-events.mjs'
import { logger } from '../../../core/logger.mjs'
import {
  acpBackendProfile,
  endpointAvailable,
} from './backend-profile.mjs'
import {
  activityFromUpdate,
  coordinatorKey,
  messageFromUpdate,
  nativeToolOutput,
  projectSessionKey,
  sessionSummary,
} from './backend-session-utils.mjs'
import { createAcpClient } from './client-factory.mjs'
import { AcpSessionRegistry } from './session-registry.mjs'
import { AcpSessionToolServer } from './session-tools.mjs'
import {
  builtinMcpServers,
  createBuiltinMcpLifecycle,
} from './builtin-mcp.mjs'
import { BackendRuntimeState } from './runtime-state.mjs'
import { KeyedSerialExecutor } from './keyed-serial-executor.mjs'
import { CoordinatorQueue } from './coordinator-queue.mjs'
import { AcpTurnUpdates, updateError } from './turn-updates.mjs'
import {
  assertProjectUpdateDelivered,
  projectTargets,
  projectUpdatePrompt,
  readWorkContinuation,
  workContinuation,
} from './work-continuation.mjs'
import { PermissionBroker } from './permission-broker.mjs'
import { InputBroker } from './input-broker.mjs'
import {
  appendPromptBlocks,
  artifactsFromAcpContentBlocks,
  nonTextPromptBlocks,
  promptWithInputParts,
  transformPromptText,
} from './content.mjs'
import { assertMcpServerCapabilities } from './capabilities.mjs'
import { buildAcpCoordinatorInstruction } from './coordinator-contract.mjs'
import {
  COORDINATOR_PROMPT_REFRESH_INTERVAL,
  coordinatorUsesMcpInstructions,
  stableCoordinatorInstructions,
} from './coordinator-instructions.mjs'
import { conversationDelta, COORDINATOR_CONVERSATION_MAX_CHARS } from '../../../core/work-conversation-context.mjs'
import {
  configureAcpSession,
  coordinatorMeta,
  normalizeAcpModel,
} from './session-configuration.mjs'

const MAX_SESSION_RESULTS = 100
const MAX_DELEGATION_RESULT_CHARS = 12_000
const MAX_DELEGATION_RECENT_UPDATES = 5
// Persistent coordinator Sessions are valid only for the contract that
// created them. Project Sessions are user work and remain independent.
const COORDINATOR_CONTRACT_VERSION = 8

export { acpBackendProfile } from './backend-profile.mjs'

function clean(value) {
  return String(value || '').trim()
}

function assertCompletedAcpTurn(result, {
  signal,
  label = 'ACP Session',
  protocol = 'acp',
} = {}) {
  const stopReason = clean(result?.response?.stopReason)
  if (stopReason === 'end_turn') return result
  if (stopReason === 'cancelled') {
    throw signal?.reason || new AgentError(`${label} 已取消`, {
      status: 499,
      protocol,
    })
  }
  const reason = {
    max_tokens: '达到最大输出长度，未能完成当前回合',
    max_turn_requests: '达到最大 Agent 请求次数，未能完成当前回合',
    refusal: '拒绝继续当前回合',
  }[stopReason] || `返回了未知的终止原因 ${stopReason || '(missing)'}`
  throw new AgentError(`${label} ${reason}`, {
    status: 502,
    protocol,
    body: clean(result?.content),
  })
}

function bounded(value, max = 300) {
  return clean(value).replace(/\s+/g, ' ').slice(0, max)
}

function delegationSummary(records, coordinatorSessionId) {
  const targets = records.map(({ id, sessionId, title, directory }) => ({
    id, sessionId, title, directory, coordinatorSessionId,
  }))
  return targets.length === 1 ? targets[0] : {
    targets,
    title: targets.map(target => target.title).join(' / ').slice(0, 160),
    coordinatorSessionId,
  }
}

function deferred() {
  let resolvePromise
  let rejectPromise
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

function waitForCancellation(promise, timeoutMs, protocol) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new AgentError(
        '后台尚未确认当前执行已停止，不能立即续接。',
        { status: 504, protocol },
      ), { code: 'cancellation_unconfirmed' })), timeoutMs)
    }),
  ]).finally(() => clearTimeout(timer))
}

function waitForRetry(delayMs, signal) {
  if (signal?.aborted) {
    return Promise.reject(signal.reason || new Error('任务已取消'))
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const finish = () => {
      signal?.removeEventListener('abort', abort)
      resolvePromise()
    }
    const timer = setTimeout(finish, delayMs)
    const abort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      rejectPromise(signal.reason || new Error('任务已取消'))
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

export class AcpBackendAdapter {
  constructor({
    protocol = 'acp',
    root = process.cwd(),
    ownership = 'owned',
    permissionMode = 'native',
    model = '',
    timeoutMs = 300_000,
    cancelTimeoutMs = 20_000,
    directory = process.cwd(),
    cliPath = '',
    configDirectory = '',
    claudeExecutable = '',
    baseUrl = '',
    token = '',
    tokenFile = '',
    coordinatorAgent = '',
    profile,
    sessionStatePath = null,
    client,
    clientFactory = createAcpClient,
    backendAvailable = endpointAvailable,
    readinessPollMs = 250,
    readinessTimeoutMs = Math.min(timeoutMs, 60_000),
    sessionToolServer,
    nativeDelegationAdapter,
    builtinMcp = builtinMcpServers(),
  } = {}) {
    this.protocol = protocol
    this.root = root
    this.ownership = ownership === 'external' ? 'external' : 'owned'
    this.permissionMode = permissionMode === 'full' ? 'full' : 'native'
    // An empty model means the Agent owns model selection for both new and
    // resumed Sessions. `auto` is retained only as a legacy configuration
    // spelling and is normalized to the same no-override state here.
    this.model = normalizeAcpModel(model)
    this.timeoutMs = timeoutMs
    // Give the client's bounded cancellation handshake time to finish, while
    // also bounding custom clients or delegation adapters that never settle.
    this.cancelTimeoutMs = cancelTimeoutMs
    this.directory = directory
    this.baseUrl = clean(baseUrl) || null
    this.coordinatorAgent = clean(coordinatorAgent)
    this.profile = profile || acpBackendProfile({
      protocol,
      root,
      ownership: this.ownership,
      directory,
      cliPath,
      baseUrl,
      token,
      tokenFile,
      coordinatorAgent,
      configDirectory,
      claudeExecutable,
      permissionMode: this.permissionMode,
      model: this.model,
    })
    this.registry = new AcpSessionRegistry({ filePath: sessionStatePath })
    this.sessionToolServer = sessionToolServer || new AcpSessionToolServer()
    // Baseline stdio MCP servers (e.g. open-computer-use) injected into every
    // Session; backends spawn and connect to them on their own.
    this.builtinMcp = this.profile.sessionMcp === false
      ? []
      : (Array.isArray(builtinMcp) ? builtinMcp : [])
    this.builtinMcpLifecycle = !client && clientFactory === createAcpClient
      ? createBuiltinMcpLifecycle(this.builtinMcp)
      : { markUsed() {}, close: () => Promise.resolve() }
    this.permissionBroker = new PermissionBroker({
      protocol: this.protocol,
      permissionMode: this.permissionMode,
    })
    this.inputBroker = new InputBroker({ protocol: this.protocol })
    this.coordinatorSessions = new Map()
    this.coordinatorSessionPromises = new Map()
    // ACP agents may cache the first MCP connection for a Session. Keep its
    // descriptor stable while serialized turns replace its run context.
    this.coordinatorToolRegistrations = new Map()
    this.coordinatorToolRegistrationPromises = new Map()
    this.sessionExecutor = new KeyedSerialExecutor()
    this.coordinatorQueue = new CoordinatorQueue()
    this.activeCoordinatorTurns = new Set()
    // Track every request that reaches the persistent coordinator Session,
    // whether it stays there or delegates to a project Session.
    this.coordinationRuns = new Map()
    this.workControllers = new Map()
    this.workUpdates = new Map()
    this.uncertainUpdateSessions = new Set()
    this.workEventListeners = new Set()
    this.runtimeState = new BackendRuntimeState({
      protocol: this.protocol,
      ownership: this.ownership,
      connectionKind: this.profile.acpConnection?.kind,
      label: this.profile.label,
      stderr: () => this.client?.stderr,
    })
    this.nativeDelegationAdapter = nativeDelegationAdapter || null
    this.backendAvailable = client ? null : backendAvailable
    this.readinessPollMs = readinessPollMs
    this.readinessTimeoutMs = readinessTimeoutMs
    this.client = client || clientFactory({
      label: this.profile.label,
      connection: this.profile.acpConnection,
      timeoutMs,
      onPermission: (params, context) => (
        this.handlePermission(params, context)
      ),
      onElicitation: (params, context) => (
        this.handleElicitation(params, context)
      ),
      sanitizeProcessOutput: this.profile.sanitizeProcessOutput,
      formatRequestError: this.profile.formatRequestError,
    })
  }

  get label() {
    return this.profile.label
  }

  coordinatorUsesMcpInstructions() {
    return coordinatorUsesMcpInstructions(this.profile)
  }

  stableCoordinatorInstructions() {
    return stableCoordinatorInstructions(this.profile)
  }

  get lastHealthFailure() {
    return this.runtimeState.lastFailure
  }

  get runtimeHealth() {
    return this.runtimeState.value
  }

  get pendingPermissions() {
    return this.permissionBroker.pending
  }

  get resolvedPermissions() {
    return this.permissionBroker.resolved
  }

  get pendingInputs() {
    return this.inputBroker.pending
  }

  describe() {
    return {
      kind: this.protocol,
      label: this.label,
      baseUrl: this.baseUrl,
      uiPath: null,
      model: this.model || null,
      directory: this.directory,
      ownership: this.ownership,
      permissionMode: this.permissionMode,
      transport: 'acp',
      acpConnection: this.profile.acpConnection?.kind || null,
      backendAgent: this.coordinatorAgent || null,
      sessionModel: 'persistent-coordinator',
      capabilities: {
        ...this.profile.capabilities,
        taskUpdates: 'activity',
        inputRequests: 'elicitation',
        workUpdates: true,
      },
    }
  }

  runtimeStatus() {
    return this.runtimeState.status({ clientReady: this.client.ready })
  }

  status(taskId, { ownerId } = {}) {
    const id = clean(taskId)
    if (!id) return this.runtimeStatus()
    const run = this.coordinationRuns.get(id)
    if (!run || (ownerId !== undefined && run.ownerId !== clean(ownerId))) {
      return { taskId: id, state: 'not_found', activity: [] }
    }
    const targets = run.delegations || []
    if (!targets.length) {
      return { taskId: id, state: 'working', activity: [] }
    }
    const statuses = targets.map(target => this.statusForDelegation({ delegation_id: target.id }))
    const current = statuses.length === 1 ? statuses[0] : {
      status: statuses.some(item => ['running', 'cancelling'].includes(item.status))
        ? 'running'
        : statuses.some(item => item.status === 'failed') ? 'failed'
          : statuses.some(item => item.status === 'cancelled') ? 'cancelled' : 'completed',
      recent_updates: statuses.flatMap(item => item.recent_updates || []),
      result: statuses.map(item => item.result).filter(Boolean).join('\n\n'),
      error: statuses.map(item => item.error).filter(Boolean).join('\n'),
    }
    return {
      taskId: id,
      state: current.status === 'running' ? 'working' : current.status,
      activity: current.recent_updates || [],
      ...(current.result ? { result: current.result } : {}),
      ...(current.error ? { error: current.error } : {}),
    }
  }

  markRuntimeReady(initialized) {
    this.runtimeState.ready(initialized)
  }

  markRuntimeFailure(error) {
    this.runtimeState.failed(error)
  }

  async start({ signal } = {}) {
    // Injected ACP clients used by embedders may already be ready and expose
    // only Session operations. The adapter itself still satisfies BackendPort.
    if (typeof this.client.start !== 'function') return this.runtimeStatus()
    try {
      await this.waitForBackendReadiness(signal)
      this.runtimeState.starting()
      const initialized = await this.client.start()
      if (this.profile.externalMcp) {
        assertMcpServerCapabilities({
          label: this.label,
          capabilities: initialized?.agentCapabilities,
          mcpServers: [{ type: 'http' }],
        })
      }
      this.markRuntimeReady(initialized)
      return this.runtimeStatus()
    } catch (error) {
      if (!signal?.aborted) this.markRuntimeFailure(error)
      throw error
    }
  }

  async health() {
    if (
      this.runtimeState.shouldBackoff()
    ) {
      return this.runtimeStatus()
    }
    try {
      if (
        this.profile.readinessMessage
        && this.baseUrl
        && this.backendAvailable
        && !await this.backendAvailable(this.baseUrl)
      ) {
        this.runtimeState.waiting(this.profile.readinessMessage)
        return this.runtimeStatus()
      }
      this.runtimeState.starting()
      const initialized = await this.client.start()
      if (this.profile.externalMcp) {
        assertMcpServerCapabilities({
          label: this.label,
          capabilities: initialized?.agentCapabilities,
          mcpServers: [{ type: 'http' }],
        })
      }
      this.markRuntimeReady(initialized)
      return this.runtimeStatus()
    } catch (error) {
      this.markRuntimeFailure(error)
      return this.runtimeStatus()
    }
  }

  needsBackendReadinessProbe() {
    return Boolean(
      this.profile.readinessMessage
      && this.baseUrl
      && this.backendAvailable,
    )
  }

  async waitForBackendReadiness(signal) {
    if (!this.needsBackendReadinessProbe()) return
    if (signal?.aborted) {
      throw signal.reason || new Error('任务已取消')
    }
    const deadline = Date.now() + this.readinessTimeoutMs
    while (!await this.backendAvailable(this.baseUrl)) {
      this.runtimeState.waiting(this.profile.readinessMessage)
      if (Date.now() >= deadline) {
        const error = new Error(
          `${this.profile.label} 后台服务启动超时`,
        )
        error.code = 'ETIMEDOUT'
        throw error
      }
      await waitForRetry(this.readinessPollMs, signal)
    }
  }

  serialize(key, operation) {
    return this.sessionExecutor.run(key, operation)
  }

  publishWorkEvent(event, { taskId, ownerId, onEvent } = {}) {
    try {
      onEvent?.(event)
    } catch {
      // A per-submission observer must not break backend execution.
    }
    const published = {
      ...event,
      taskId: clean(taskId) || null,
      ownerId: clean(ownerId) || null,
    }
    for (const listener of this.workEventListeners) {
      try {
        listener(published)
      } catch {
        // Subscribers are isolated from the adapter and from each other.
      }
    }
  }

  subscribe(listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('BackendPort subscriber must be a function')
    }
    this.workEventListeners.add(listener)
    return () => this.workEventListeners.delete(listener)
  }

  coordinatorSessionKey(ownerId, sessionId = '') {
    const key = coordinatorKey(ownerId, this.protocol)
    const session = this.coordinatorSessions.get(key) || this.registry.get(key)
    if (!sessionId || session?.sessionId === sessionId) return key
    throw updateError('context_unavailable', '原后台会话已不可用，未在其他会话中自动重做。')
  }

  async acquireCoordinator(ownerId, { sessionId = '', signal } = {}) {
    return this.coordinatorQueue.acquire(this.coordinatorSessionKey(ownerId, sessionId), { signal })
  }

  async ensureCoordinatorSession(ownerId, mcpServers = [], { expectedSessionId = '' } = {}) {
    if (this.builtinMcp.length) this.builtinMcpLifecycle.markUsed()
    const key = coordinatorKey(ownerId, this.protocol)
    if (this.coordinatorSessions.has(key)) {
      const session = this.coordinatorSessions.get(key)
      if (session.connectionGeneration === this.client.connectionGeneration) return session
      // A fresh ACP process must restore the Session and reconnect its MCPs.
      this.coordinatorSessions.delete(key)
    }
    if (this.coordinatorSessionPromises.has(key)) {
      return this.coordinatorSessionPromises.get(key)
    }
    const pending = (async () => {
      const stored = this.registry.get(key)
      const contractVersion = COORDINATOR_CONTRACT_VERSION
      let session
      const canResumeStored = Boolean(
        stored?.sessionId
        && stored.contractVersion === contractVersion,
      )
      if (stored?.sessionId && !canResumeStored) {
        this.registry.delete(key)
      }
      if (canResumeStored) {
        try {
          session = await this.client.resumeSession(stored.sessionId, {
            cwd: stored.cwd || this.directory,
            mcpServers,
            meta: this.coordinatorMeta(ownerId, key),
            ownerId,
            role: 'coordinator',
          })
          const accepted = this.profile.acceptResumedSession?.({
            session,
            role: 'coordinator',
            coordinatorAgent: this.coordinatorAgent,
          }) !== false
          if (!accepted) {
            this.registry.delete(key)
            session = null
          } else {
            session.isNew = false
            session.conversationCursors = stored.conversationCursors
            session.coordinatorPromptTurns = stored.coordinatorPromptTurns
          }
        } catch {
          if (expectedSessionId) {
            throw updateError('context_unavailable', '原协调会话无法恢复，未创建替代会话。')
          }
          this.registry.delete(key)
        }
      }
      if (!session) {
        if (expectedSessionId) {
          throw updateError('context_unavailable', '原协调会话不可用或不兼容，未创建替代会话。')
        }
        session = await this.client.newSession({
          cwd: this.directory,
          mcpServers,
          meta: this.coordinatorMeta(ownerId, key),
          ownerId,
          role: 'coordinator',
        })
        session.isNew = true
      }
      session.contractVersion = contractVersion
      await this.configureSession(session, 'coordinator')
      this.coordinatorSessions.set(key, session)
      this.registry.set(key, session)
      return session
    })().finally(() => this.coordinatorSessionPromises.delete(key))
    this.coordinatorSessionPromises.set(key, pending)
    return pending
  }

  async ensureCoordinatorToolRegistration(ownerId, context) {
    if (!this.profile.externalMcp) return null
    const key = coordinatorKey(ownerId, this.protocol)
    const current = this.coordinatorToolRegistrations.get(key)
    if (current) {
      current.update(context)
      return current
    }
    const existingPromise = this.coordinatorToolRegistrationPromises.get(key)
    if (existingPromise) {
      const registration = await existingPromise
      registration.update(context)
      return registration
    }
    const pending = this.sessionToolServer.register(context, {
      instructions: this.coordinatorUsesMcpInstructions()
        ? this.stableCoordinatorInstructions()
        : '',
    }).then(
      registration => {
        this.coordinatorToolRegistrations.set(key, registration)
        return registration
      },
    ).finally(() => {
      this.coordinatorToolRegistrationPromises.delete(key)
    })
    this.coordinatorToolRegistrationPromises.set(key, pending)
    return pending
  }

  coordinatorMeta(ownerId) {
    return coordinatorMeta(this.profile, ownerId)
  }

  async configureSession(session, role) {
    return configureAcpSession({
      client: this.client,
      coordinatorAgent: this.coordinatorAgent,
      label: this.label,
      model: this.model,
      profile: this.profile,
      protocol: this.protocol,
    }, session, role)
  }

  async handlePermission(params, { signal, session } = {}) {
    return this.permissionBroker.request(params, { signal, session })
  }

  async handleElicitation(params, { signal, session } = {}) {
    return this.inputBroker.request(params, { signal, session })
  }

  cancelPermission(record) {
    return this.permissionBroker.cancel(record)
  }

  async resolveAuthorization(id, decision, { ownerId } = {}) {
    return this.permissionBroker.respond(id, decision, { ownerId })
  }

  cancelPermissionsForScope(permissionScopeId) {
    this.permissionBroker.cancelScope(permissionScopeId)
    this.inputBroker.cancelScope(permissionScopeId)
  }

  rememberDelegationUpdate(record, activity) {
    if (
      !record
      || !activity
      || !['plan', 'tool', 'thinking', 'mode', 'session'].includes(activity.kind)
    ) {
      return
    }
    const key = clean(activity.id)
      || `${activity.kind}:${clean(activity.tool)}:${clean(activity.detail)}`
    const summary = Object.fromEntries(Object.entries(activity)
      .filter(([name, value]) => (
        name !== 'id'
        && value !== ''
        && value !== null
        && value !== undefined
      )))
    record.recentUpdates ||= []
    record.recentUpdates = record.recentUpdates
      .filter(item => item.key !== key)
    record.recentUpdates.push({ key, summary })
    record.recentUpdates = record.recentUpdates
      .slice(-MAX_DELEGATION_RECENT_UPDATES)
  }

  onSessionUpdate(run, update, { delegation = null } = {}) {
    if (delegation
      ? delegation.status !== 'running' || delegation.signal?.aborted
      : run.closed || run.turnClosed) return
    run.receivedUpdate = true
    run.toolCalls ||= new Map()
    run.messageStreams ||= {}
    const streamedMessage = messageFromUpdate(update, run.messageStreams)
    if (streamedMessage?.message) {
      run.onEvent?.(backendEvent(BackendEventType.MESSAGE, {
        ...streamedMessage,
        streaming: true,
      }))
    }
    const activity = activityFromUpdate(update, run.toolCalls)
    if (activity) run.onEvent?.(backendEvent(BackendEventType.ACTIVITY, { activity }))
    if (delegation && this.profile.externalMcp) {
      this.rememberDelegationUpdate(delegation, activity)
    }
    if (delegation || !this.profile.nativeDelegation || run.allowDelegation === false) return
    if (!['tool_call', 'tool_call_update'].includes(update?.sessionUpdate)) {
      return
    }
    const id = clean(update.toolCallId)
    const merged = {
      ...(run.nativeToolCalls.get(id) || {}),
      ...update,
    }
    run.nativeToolCalls.set(id, merged)
    if (merged.status !== 'completed') return
    const name = clean(merged.name || merged.title).toLowerCase()
    if (!/sessions_(spawn|send)/.test(name)) return
    const output = nativeToolOutput(merged.rawOutput)
    const sessionId = clean(
      output.childSessionKey
      || output.sessionKey
      || output.session_id
      || output.sessionId,
    )
    if (!sessionId) return
    const delegationId = clean(output.runId)
    if (!delegationId || run.delegations.some(record => record.id === delegationId)) return
    this.createNativeDelegation(run, {
      delegationId,
      sessionId,
      directory: clean(
        merged.rawInput?.cwd
        || merged.rawInput?.directory
        || this.directory,
      ),
      title: bounded(
        merged.rawInput?.label
        || merged.rawInput?.task
        || merged.rawInput?.message,
        160,
      ) || this.profile.defaultDelegationTitle || `${this.label} 项目任务`,
    })
  }

  async listProjectSessions({ query, limit } = {}) {
    const sessions = await this.client.listSessions({
      limit: limit || 20,
    })
    const coordinators = new Set([
      ...this.coordinatorSessions.values(),
      ...this.registry.coordinatorEntries().map(([, session]) => session),
    ].map(item => item.sessionId))
    this.registry.setProjects(sessions
      .filter(session => clean(session?.sessionId) && clean(session?.cwd)
        && !coordinators.has(clean(session.sessionId)))
      .map(session => [
        projectSessionKey(this.protocol, session.sessionId),
        session,
      ]))
    const needle = clean(query).toLowerCase()
    return {
      sessions: sessions
        .filter(session => !coordinators.has(clean(session.sessionId)))
        .map(sessionSummary)
        .filter(session => !needle || [
          session.title,
          session.directory,
        ].join(' ').toLowerCase().includes(needle)),
    }
  }

  rememberProjectSession(session) {
    if (!clean(session?.sessionId) || !clean(session?.cwd)) return
    this.registry.setProject(
      projectSessionKey(this.protocol, session.sessionId),
      session,
    )
  }

  findDelegation({ delegation_id: delegationId, session_id: sessionId }) {
    return [...this.coordinationRuns.values()]
      .flatMap(run => run.delegations || []).reverse()
      .find(record => (
        (clean(delegationId) && record?.id === clean(delegationId))
        || (clean(sessionId) && record?.sessionId === clean(sessionId))
      ))
  }

  createDelegation(run, {
    session,
    prompt,
    directory,
    title,
  }) {
    const controller = new AbortController()
    const record = {
      id: `${this.protocol}_run_${randomUUID()}`,
      sessionId: session.sessionId,
      directory,
      title: bounded(title || prompt, 160) || `${this.label} 项目任务`,
      ownerId: run.ownerId,
      taskId: run.coordinationRunId,
      status: 'running',
      controller,
      signal: run.signal ? AbortSignal.any([controller.signal, run.signal]) : controller.signal,
      recentUpdates: [],
      result: null,
      error: null,
    }
    // Continuations replace the previous result for this exact target, never
    // another child's context. The collection is shared by all turns of a Work.
    const previous = run.delegations.findIndex(item => item.sessionId === record.sessionId)
    if (previous < 0) run.delegations.push(record)
    else run.delegations.splice(previous, 1, record)
    record.turnUpdates = new AcpTurnUpdates({
      client: this.client, sessionId: record.sessionId, signal: record.signal,
      onRestart: () => this.cancelPermissionsForScope(session.permissionScopeId),
    })
    record.promise = this.serialize(`target:${record.sessionId}`, async () => {
      const permissionScopeId = `prompt_${randomUUID()}`
      try {
        session.ownerId = run.ownerId
        session.coordinationRunId = run.coordinationRunId
        session.onEvent = run.onEvent
        session.permissionScopeId = permissionScopeId
        const result = assertCompletedAcpTurn(await record.turnUpdates.run(
          appendPromptBlocks(prompt, run.inputBlocks),
          {
            signal: record.signal,
            timeoutMs: 0,
            onUpdate: update => this.onSessionUpdate(run, update, {
              delegation: record,
            }),
          },
        ), {
          signal: record.signal,
          label: `${this.label} 项目 Session`,
          protocol: this.protocol,
        })
        record.status = 'completed'
        record.result = result
        return {
          id: record.id,
          sessionId: record.sessionId,
          directory: record.directory,
          title: record.title,
          content: result.content,
          contentBlocks: result.contentBlocks || [],
        }
      } catch (error) {
        if (error.contextUncertain) this.uncertainUpdateSessions.add(record.sessionId)
        record.status = record.signal.aborted ? 'cancelled' : 'failed'
        record.error = error
        throw error
      } finally {
        this.cancelPermissionsForScope(permissionScopeId)
        if (session.permissionScopeId === permissionScopeId) {
          session.permissionScopeId = null
        }
      }
    })
    record.promise.catch(() => {})
    this.publishDelegation(run)
    return record
  }

  publishDelegation(run, { yielded = false } = {}) {
    run.onEvent?.({
      type: BackendEventType.DELEGATED,
      yielded,
      delegation: delegationSummary(run.delegations, run.sessionId),
    })
  }

  assertActiveCoordinatorRun(run) {
    if (run.closed || run.turnClosed || run.signal?.aborted) {
      throw new AgentError('原协调请求已结束，Session 工具上下文已失效', {
        protocol: this.protocol,
      })
    }
  }

  async startProjectSession(run, { prompt, title }) {
    this.assertActiveCoordinatorRun(run)
    if (run.allowDelegation === false || run.phase === 'update') {
      throw updateError('invalid_session_route', '当前轮次只能处理已有工作的要求，不能创建新工作。')
    }
    const cwd = clean(run.cwd) || this.directory
    const session = await this.client.newSession({
      cwd,
      mcpServers: this.builtinMcp,
      ownerId: run.ownerId,
      role: 'project',
    })
    this.assertActiveCoordinatorRun(run)
    this.rememberProjectSession({
      ...session,
      cwd,
      title: clean(title || prompt),
    })
    await this.configureSession(session, 'project')
    this.assertActiveCoordinatorRun(run)
    const record = this.createDelegation(run, {
      session,
      prompt: clean(prompt),
      directory: cwd,
      title,
    })
    return {
      status: 'started',
      delegation_id: record.id,
      session_id: record.sessionId,
      title: record.title,
      directory: record.directory,
    }
  }

  async continueProjectSession(
    run,
    input,
  ) {
    return this.serialize(`target-setup:${clean(input.session_id)}`, () => (
      this.continueIdleProjectSession(run, input)
    ))
  }

  async continueIdleProjectSession(
    run,
    { session_id: sessionId, prompt },
  ) {
    // A call admitted before this target's setup queue drained may belong to
    // an already-ended coordinator turn. Do not resume or steer it afterward.
    this.assertActiveCoordinatorRun(run)
    if (this.uncertainUpdateSessions.has(sessionId)) {
      throw updateError('context_unavailable', '目标会话未确认上一轮调整是否结束，请重启后台后再继续。')
    }
    const active = this.findDelegation({ session_id: sessionId })
    if (run.phase === 'update') {
      if (!projectTargets(run).some(record => record.sessionId === sessionId)) {
        throw updateError('invalid_session_route', '只能调整当前请求关联的项目 Session。')
      }
      if (active?.status === 'running' && active.taskId === run.coordinationRunId) {
        if (!active.turnUpdates) throw updateError('update_unsupported', '目标未提供定向调整入口。')
        await active.turnUpdates.enqueue(appendPromptBlocks(prompt, run.inputBlocks)).completion
        run.updatedTargets += 1
        return { status: 'updated', session_id: sessionId, delegation_id: active.id }
      }
    } else if (run.allowDelegation === false) {
      throw updateError('invalid_session_route', '结果整理轮次不能重新执行工作。')
    }
    if (this.sessionExecutor.queues.has(`target:${sessionId}`)
      || active?.status === 'running' || active?.status === 'cancelling') {
      throw updateError('session_busy', '目标项目会话正在执行其他工作，请调整原任务或等待其结束。')
    }
    const remembered = this.registry.getProject(
      projectSessionKey(this.protocol, sessionId),
    )
    let existing = null
    let cwd = clean(
      active?.directory
      || run.projectTargets?.find(target => target.sessionId === sessionId)?.directory
      || remembered?.cwd,
    )
    if (!cwd) {
      const sessions = await this.client.listSessions({
        limit: MAX_SESSION_RESULTS,
      })
      this.assertActiveCoordinatorRun(run)
      existing = sessions.find(item => (
        clean(item.sessionId) === clean(sessionId)
      ))
      cwd = clean(existing?.cwd)
    }
    if (!cwd) {
      throw new AgentError(
        `${this.label} Session 的项目目录未知，请先查询 Session 列表后再继续`,
        { protocol: this.protocol },
      )
    }
    const session = await this.client.resumeSession(clean(sessionId), {
      cwd,
      mcpServers: this.builtinMcp,
      ownerId: run.ownerId,
      role: 'project',
    })
    this.assertActiveCoordinatorRun(run)
    this.rememberProjectSession({
      ...existing,
      ...session,
      cwd,
      title: existing?.title || remembered?.title,
    })
    await this.configureSession(session, 'project')
    this.assertActiveCoordinatorRun(run)
    const record = this.createDelegation(run, {
      session,
      prompt: clean(prompt),
      directory: cwd,
      title: clean(prompt),
    })
    if (run.phase === 'update') run.updatedTargets += 1
    return {
      status: 'started',
      delegation_id: record.id,
      session_id: record.sessionId,
      title: record.title,
      directory: record.directory,
    }
  }

  statusForDelegation(input) {
    const record = this.findDelegation(input)
    if (!record) return { status: 'not_found' }
    return {
      status: record.status,
      delegation_id: record.id,
      session_id: record.sessionId,
      title: record.title,
      directory: record.directory,
      ...(Array.isArray(record.recentUpdates)
        ? { recent_updates: record.recentUpdates.map(item => item.summary) }
        : {}),
      ...(record.status === 'completed'
        ? { result: clean(record.result?.content).slice(0, 4000) }
        : {}),
      ...(record.status === 'failed'
        ? { error: clean(record.error?.message || record.error) }
        : {}),
    }
  }

  async cancelDelegation(input) {
    const record = this.findDelegation(input)
    if (!record) return { status: 'not_found' }
    const nativeStillActive = record.nativeCompletion && !record.remoteStopped && record.status !== 'completed'
    if (nativeStillActive || !['completed', 'failed', 'cancelled'].includes(record.status)) {
      record.cancellation ||= (async () => {
        record.controller.abort(new Error('用户已取消这项项目任务'))
        if (record.nativeCompletion && this.nativeDelegationAdapter) {
          await this.nativeDelegationAdapter.cancel({ runId: record.id, sessionId: record.sessionId })
        } else {
          await this.client.cancelSession(record.sessionId)
        }
        record.remoteStopped = true
        record.status = 'cancelled'
      })()
      await record.cancellation
    }
    return {
      status: record.status,
      delegation_id: record.id,
      session_id: record.sessionId,
    }
  }

  toolContext(run) {
    const active = operation => input => {
      this.assertActiveCoordinatorRun(run)
      return operation(input)
    }
    return {
      listSessions: active(input => this.listProjectSessions(input)),
      startSession: active(input => this.startProjectSession(run, input)),
      sendSession: active(input => this.continueProjectSession(run, input)),
      sessionStatus: active(input => this.statusForDelegation(input)),
      cancelSession: active(input => this.cancelDelegation(input)),
    }
  }

  prepareCoordinatorInstructions(session, message) {
    const turns = Number.isSafeInteger(session.coordinatorPromptTurns) && session.coordinatorPromptTurns >= 0
      ? session.coordinatorPromptTurns : 0
    const instructions = turns % COORDINATOR_PROMPT_REFRESH_INTERVAL === 0
      ? this.stableCoordinatorInstructions() : ''
    let acknowledged = false
    return {
      prompt: instructions ? transformPromptText(message, content => [
        '<qwen_audio_agent_backend_profile>',
        instructions,
        '</qwen_audio_agent_backend_profile>',
        '',
        content,
      ].join('\n')) : message,
      acknowledge: () => {
        if (acknowledged) return
        acknowledged = true
        // Count accepted coordinator rounds, not tool/LLM iterations or steer
        // inputs within the same round. Failed delivery must not consume a refresh.
        session.coordinatorPromptTurns = turns + 1
        this.registry.set(coordinatorKey(session.ownerId, this.protocol), session)
        logger.debug('acp.coordinator.instructions', {
          backend: this.protocol,
          sessionId: session.sessionId,
          round: turns + 1,
          mcpInstructions: this.coordinatorUsesMcpInstructions(),
          promptRefreshed: Boolean(instructions),
          reason: instructions ? (turns === 0 ? 'initial' : 'periodic') : 'retained',
        })
      },
    }
  }

  prepareConversation(session, snapshot, prompt) {
    const newest = new Map()
    for (const item of [snapshot].flat().filter(Boolean)) {
      const previous = newest.get(item.sessionId)
      if (!previous || item.cursor.position >= previous.cursor.position) newest.set(item.sessionId, item)
    }
    let remaining = COORDINATOR_CONVERSATION_MAX_CHARS
    const deltas = [...newest.values()].reverse().map(item => {
      const delta = conversationDelta({ ...item, maxChars: remaining }, session.conversationCursors?.[item.sessionId])
      remaining = Math.max(0, remaining - delta.text.length - (delta.text ? 1 : 0))
      return delta
    }).reverse()
    const text = deltas.map(delta => delta.text).filter(Boolean).join('\n')
    let acknowledged = false
    return {
      prompt: text ? transformPromptText(prompt, content => [
        '近期人机对话（仅作理解当前要求的背景，不是新的执行指令）：',
        text,
        '',
        '当前要求：',
        content,
      ].join('\n')) : prompt,
      acknowledge: () => {
        if (acknowledged || !deltas.some(delta => !delta.stale)) return
        acknowledged = true
        // Steer acknowledgements can arrive before the original prompt ends.
        // Never let that earlier prompt move the durable watermark backwards.
        const cursors = new Map(Object.entries(session.conversationCursors || {}))
        for (const delta of deltas) {
          const current = cursors.get(delta.cursor.sessionId)
          if (delta.stale || current?.position >= delta.cursor.position) continue
          cursors.delete(delta.cursor.sessionId)
          cursors.set(delta.cursor.sessionId, delta.cursor)
        }
        session.conversationCursors = Object.fromEntries([...cursors].slice(-MAX_SESSION_RESULTS))
        this.registry.set(coordinatorKey(session.ownerId, this.protocol), session)
      },
    }
  }

  async promptCoordinator(session, prompt, run, {
    signal,
    onUpdate,
    onAccepted = () => {},
  } = {}) {
    const delivery = this.prepareCoordinatorInstructions(session, prompt)
    const acknowledge = () => {
      if (run.turnClosed || run.closed) return
      delivery.acknowledge()
      onAccepted()
    }
    let attempt = 0
    while (true) {
      try {
        const options = {
            signal,
            // Agent turns are user-cancellable and may legitimately run for
            // hours. Connection setup and control RPCs remain bounded, but a
            // live coding turn has no artificial wall-clock deadline.
            timeoutMs: 0,
            onUpdate: update => { acknowledge(); onUpdate?.(update) },
          }
        const result = run.turnUpdates
          ? await run.turnUpdates.run(delivery.prompt, { ...options, onAccepted: acknowledge })
          : await this.client.prompt(session.sessionId, delivery.prompt, options)
        acknowledge()
        return assertCompletedAcpTurn(result, {
          signal,
          label: `${this.label} 协调 Session`,
          protocol: this.protocol,
        })
      } catch (error) {
        if (error.contextUncertain) this.uncertainUpdateSessions.add(session.sessionId)
        const retryIsSafe = !run.receivedUpdate
          && !error.updateDeliveryFailed
          && !run.turnUpdates?.hasUpdates
          && !run.delegations.length
          && run.nativeToolCalls.size === 0
          && run.toolCalls.size === 0
        const delayMs = retryIsSafe
          ? this.profile.promptRetryDelay?.({ error, attempt })
          : null
        if (!Number.isFinite(delayMs) || delayMs < 0) throw error
        // No updates were admitted; retain the existing provider's safe initial retry.
        if (run.turnUpdates) run.turnUpdates.closed = false
        attempt += 1
        await waitForRetry(delayMs, signal)
      }
    }
  }

  async coordinatorTurn(message, {
    ownerId,
    coordinationRunId,
    coordinationRequestId,
    signal,
    onEvent,
    delegations = [],
    projectTargets: savedProjectTargets = [],
    phase = 'execute',
    conversation,
    workObjective,
  }) {
    const run = {
      ownerId: clean(ownerId),
      coordinationRunId: clean(coordinationRunId),
      coordinationRequestId: clean(coordinationRequestId)
        || clean(coordinationRunId),
      onEvent,
      delegations,
      projectTargets: savedProjectTargets,
      signal,
      phase,
      updatedTargets: 0,
      objective: clean(workObjective),
      allowDelegation: phase === 'execute',
      nativeToolCalls: new Map(),
      toolCalls: new Map(),
      initialPromptDone: false,
      receivedUpdate: false,
      inputBlocks: nonTextPromptBlocks(message),
      coordinatorKey: coordinatorKey(ownerId, this.protocol),
    }
    if (run.coordinationRunId) {
      const previous = this.coordinationRuns.get(run.coordinationRunId)
      if (previous) previous.closed = true
      this.coordinationRuns.set(run.coordinationRunId, run)
    }
    const key = run.coordinatorKey
    const pendingFacts = this.registry.reconciliationsFor(key)
    const prompt = pendingFacts.length
      ? transformPromptText(message, content => [
          '先前请求已取消，不要续接其未完成内容。仅处理以下新请求。',
          ...pendingFacts.filter(fact => fact.objective).map(fact => `已取消的要求：${fact.objective}`),
          '',
          content,
        ].join('\n'))
      : message
    const registration = await this.ensureCoordinatorToolRegistration(
      ownerId,
      this.toolContext(run),
      key,
    )
    const mcpServers = [
      ...(registration ? [registration.descriptor] : []),
      ...this.builtinMcp,
    ]
    const updates = this.workUpdates.get(clean(coordinationRunId))
    const session = await this.ensureCoordinatorSession(ownerId, mcpServers, {
      expectedSessionId: updates?.expectedSessionId,
    })
    if (this.uncertainUpdateSessions.has(session.sessionId)) {
      throw updateError('context_unavailable', '后台未确认上一轮调整是否结束，请重启后台后再继续。')
    }
    if (updates?.expectedSessionId && updates.expectedSessionId !== session.sessionId) {
      throw updateError('context_unavailable', '原后台会话已不可用，未在其他会话中自动重做。')
    }
    const permissionScopeId = `prompt_${randomUUID()}`
    run.sessionId = session.sessionId
    run.cwd = clean(session.cwd) || this.directory
    session.ownerId = clean(ownerId)
    session.coordinationRunId = clean(coordinationRunId)
    session.onEvent = onEvent
    session.permissionScopeId = permissionScopeId
    this.activeCoordinatorTurns.add(session.sessionId)
    if (updates) {
      run.turnUpdates = new AcpTurnUpdates({
        client: this.client, sessionId: session.sessionId, signal,
        onRestart: () => this.cancelPermissionsForScope(permissionScopeId),
        preparePrompt: (prompt, contexts = []) => this.prepareConversation(
          session, contexts, prompt,
        ),
      })
      updates.active = run.turnUpdates
      updates.started = true
      const pending = updates.pending.splice(0)
      conversation = [conversation, ...pending.map(entry => entry.conversation)].flat().filter(Boolean)
      for (const entry of pending) {
        // These updates are part of the initial prompt, whose snapshot is
        // prepared once below. Later steer batches carry their own snapshots.
        const receipt = run.turnUpdates.enqueue(entry.prompt)
        receipt.completion.then(async () => {
          // A queued requirement is not delivered to a project merely because
          // the coordinator accepted its prompt. Wait for its actual routing.
          const delivery = await updates.projectDelivery?.promise
          if (delivery?.error) entry.reject(delivery.error)
          else entry.resolve()
        }, entry.reject)
      }
    }
    try {
      // ensureCoordinatorSession supplies MCPs on create/restore. An active
      // Session already owns those connections; resuming it again is not a
      // valid refresh operation for every ACP implementation.
      const delivery = this.prepareConversation(session, conversation, prompt)
      const result = await this.promptCoordinator(session, delivery.prompt, run, {
        signal,
        onAccepted: delivery.acknowledge,
        onUpdate: update => this.onSessionUpdate(run, update),
      })
      if (
        !clean(result?.content)
        && !(result?.contentBlocks || []).some(block => block?.type !== 'text')
      ) {
        const error = new AgentError(
          `${this.profile.label} ACP Session 未返回任何内容`,
          { status: 502, protocol: this.protocol },
        )
        error.recoverWithFreshCoordinator = !run.receivedUpdate
          && !updates?.expectedSessionId
          && !run.turnUpdates?.hasUpdates
          && !run.delegations.length
          && run.nativeToolCalls.size === 0
          && run.toolCalls.size === 0
        throw error
      }
      run.initialPromptDone = true
      session.isNew = false
      if (pendingFacts.length) {
        this.registry.acknowledgeReconciliations(key, pendingFacts)
      }
      this.registry.set(
        key,
        session,
      )
      return {
        run,
        session,
        result,
      }
    } finally {
      run.turnClosed = true
      if (updates && updates.active === run.turnUpdates) updates.active = null
      this.activeCoordinatorTurns.delete(session.sessionId)
      this.cancelPermissionsForScope(permissionScopeId)
      if (session.permissionScopeId === permissionScopeId) {
        session.permissionScopeId = null
      }
    }
  }

  createNativeDelegation(run, {
    delegationId,
    sessionId,
    directory,
    title,
  }) {
    const controller = new AbortController()
    const record = {
      id: delegationId,
      sessionId,
      directory,
      title,
      ownerId: run.ownerId,
      taskId: run.coordinationRunId,
      status: 'running',
      controller,
      signal: run.signal ? AbortSignal.any([controller.signal, run.signal]) : controller.signal,
      result: null,
      error: null,
      parentSessionId: run.sessionId,
      nativeCompletion: deferred(),
    }
    run.delegations.push(record)
    record.promise = this.waitForNativeDelegation(record, run)
    record.promise.catch(() => {})
    this.publishDelegation(run)
    return record
  }

  async waitForNativeDelegation(record) {
    const abort = () => record.nativeCompletion.reject(record.signal.reason)
    record.signal?.addEventListener('abort', abort, { once: true })
    record.nativeCompletion.promise.catch(() => {})
    try {
      record.signal?.throwIfAborted()
      const completed = this.nativeDelegationAdapter
        ? await this.nativeDelegationAdapter.wait({
            runId: record.id,
            sessionId: record.sessionId,
            signal: record.signal,
          })
        : { content: await record.nativeCompletion.promise }
      const content = clean(completed?.content)
      record.status = 'completed'
      record.result = {
        content,
        contentBlocks: completed?.contentBlocks || [],
      }
      return {
        id: record.id,
        sessionId: record.sessionId,
        directory: record.directory,
        title: record.title,
        content,
        contentBlocks: completed?.contentBlocks || [],
      }
    } catch (error) {
      record.status = record.signal?.aborted ? 'cancelled' : 'failed'
      record.error = error
      throw error
    } finally {
      record.signal?.removeEventListener('abort', abort)
    }
  }

  delegationResultPrompt(result, objective = '') {
    const task = clean(objective || result.title).slice(0, 2_000)
    const instruction = [
      '独立工作已结束。以下是与当前请求关联的可信执行结果（可能包含失败）：',
      ...(task ? ['', `原任务：${task}`] : []),
      '',
      clean(result.content).slice(0, MAX_DELEGATION_RESULT_CHARS),
      '',
      '请只整理以上可信结果，直接给出自然的最终答复；',
      '不要输出任务状态或展示协议，也不要再次执行、委托或查询目标任务。',
    ].join('\n')
    const nonTextBlocks = (result.contentBlocks || [])
      .filter(block => block?.type !== 'text')
    return appendPromptBlocks(instruction, nonTextBlocks)
  }

  resultEnvelope(initial, delegation = null, priorContentBlocks = []) {
    return {
      content: initial.result.content,
      continuation: workContinuation(this.protocol, initial.session.sessionId, initial.run),
      contentBlocks: [
        ...(priorContentBlocks || []),
        ...(delegation?.contentBlocks || []),
        ...(initial.result.contentBlocks || []),
      ],
      raw: initial.result.response,
      protocol: this.protocol,
      metadata: {
        backendRef: {
          provider: this.protocol,
          role: 'backend',
          sessionId: initial.session.sessionId,
          directory: initial.session.cwd || this.directory,
        },
        ...(delegation
          ? {
              delegation: delegationSummary(initial.run.delegations, initial.session.sessionId),
            }
          : {}),
      },
    }
  }

  discardCoordinatorSession(ownerId, sessionId = '') {
    const key = coordinatorKey(ownerId, this.protocol)
    const current = this.coordinatorSessions.get(key)
    if (!sessionId || current?.sessionId === sessionId) {
      this.coordinatorSessions.delete(key)
    }
    this.registry.delete(key)
  }

  async coordinatorTurnWithRecovery(message, options = {}) {
    try {
      return await this.coordinatorTurn(message, options)
    } catch (error) {
      if (!error?.recoverWithFreshCoordinator) throw error
      this.discardCoordinatorSession(options.ownerId)
      return this.coordinatorTurn(message, options)
    }
  }

  beginWork(taskId, ownerId, { signal, expectedSessionId = '', continuingProjects = false } = {}) {
    if (this.closePromise) {
      throw new AgentError('BackendPort is closing or closed', {
        status: 503, protocol: this.protocol,
      })
    }
    if (this.workControllers.has(taskId)) {
      throw new AgentError('BackendPort Task is already active', {
        status: 409, protocol: this.protocol,
      })
    }
    const controller = new AbortController()
    const updates = {
      ownerId, active: null, pending: [], started: false, expectedSessionId,
      controls: Promise.resolve(), finalizing: false, settled: deferred(),
      projectDelivery: continuingProjects ? deferred() : null,
    }
    this.workControllers.set(taskId, controller)
    this.workUpdates.set(taskId, updates)
    return {
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      updates,
      finish: error => {
        updates.projectDelivery?.resolve({ error: error || updateError(
          'update_not_delivered', '后台执行结束前未将要求送达项目会话。',
        ) })
        updates.pending.splice(0).forEach(entry => entry.reject(
          updateError('update_not_delivered', '后台执行结束前未投递追加要求。'),
        ))
        if (this.workUpdates.get(taskId) === updates) this.workUpdates.delete(taskId)
        if (this.workControllers.get(taskId) === controller) this.workControllers.delete(taskId)
        updates.settled.resolve({ error })
      },
    }
  }

  async submit(work, { signal, onEvent } = {}) {
    const taskId = clean(work?.id)
    const ownerId = clean(work?.ownerId)
    const objective = clean(work?.objective ?? work?.message ?? work?.instruction)
    if (!taskId || !ownerId || !objective) {
      throw new AgentError('BackendPort submit requires task id, owner and input', {
        status: 400,
        protocol: this.protocol,
      })
    }
    const continuation = readWorkContinuation(work?.resumeContext, this.protocol)
    const execution = this.beginWork(taskId, ownerId, {
      signal, expectedSessionId: continuation?.token,
      continuingProjects: Boolean(continuation?.projects.length),
    })
    const workSignal = execution.signal
    let executionError
    try {
      if (work?.continuity === 'isolated') {
        return await this.submitIsolated(work, {
          ownerId,
          taskId,
          objective,
          signal: workSignal,
          onEvent,
        })
      }
      const prompt = buildAcpCoordinatorInstruction({
        ...work,
        objective,
      })
      const run = message => this.runCoordinator(message, {
        ownerId,
        coordinationRunId: taskId,
        coordinationRequestId: taskId,
        workObjective: objective,
        conversation: work.conversation,
        projectTargets: continuation?.projects,
        signal: workSignal,
        onEvent,
      })
      const result = await run(promptWithInputParts(prompt, work?.inputParts))
      const artifacts = artifactsFromAcpContentBlocks(result?.contentBlocks)
      if (!clean(result?.content) && !artifacts.length) {
        throw new AgentError('Coordinator backend returned an empty response', {
          status: 502,
          protocol: this.protocol,
        })
      }
      return {
        content: clean(result?.content),
        artifacts,
        continuation: result.continuation,
      }
    } catch (error) {
      executionError = error
      throw error
    } finally {
      execution.finish(executionError)
    }
  }

  update(taskId, input, { ownerId } = {}) {
    const id = clean(taskId)
    const updates = this.workUpdates.get(id)
    const run = this.coordinationRuns.get(id)
    if (!updates || updates.ownerId !== clean(ownerId)) {
      throw updateError('task_not_running', '指定工作没有可调整的活动执行。')
    }
    if (this.workControllers.get(id)?.signal.aborted) {
      throw updateError('task_cancelling', '指定工作正在取消。')
    }
    const instruction = clean(input?.instruction)
    if (!instruction) throw updateError('missing_instruction', '调整要求不能为空。')
    const prompt = promptWithInputParts(instruction, input?.inputParts)
    if (updates.finalizing) throw updateError('update_busy', '工作正在整理最终结果，请稍后继续。')
    if (run && projectTargets(run).length) {
      if (run.delegations.some(target => !target.turnUpdates)) {
        throw updateError('update_unsupported', '当前后台内部委托未提供可靠的定向调整入口。')
      }
      // The coordinator owns the requirements and target selection, even for
      // one child. Only its session_send performs the actual target update.
      const completion = updates.controls.then(() => this.routeDelegatedUpdate(run, prompt, input?.conversation))
      updates.controls = completion.catch(() => {})
      return { completion }
    }
    if (updates.active) return updates.active.enqueue(prompt, { context: input?.conversation })
    if (updates.started) throw updateError('task_not_running', '当前轮次已经结束，请稍后续接。')
    let resolve
    let reject
    const completion = new Promise((yes, no) => { resolve = yes; reject = no })
    completion.catch(() => {})
    updates.pending.push({ prompt, conversation: input?.conversation, resolve, reject })
    return { completion }
  }

  async routeDelegatedUpdate(run, prompt, conversation) {
    const targets = projectTargets(run)
    const routed = await this.withCoordinatorTurn(projectUpdatePrompt(targets, prompt), {
      ownerId: run.ownerId,
      coordinationRunId: run.coordinationRunId,
      signal: run.signal,
      onEvent: run.onEvent,
      delegations: run.delegations,
      projectTargets: targets,
      phase: 'update',
      conversation,
    })
    assertProjectUpdateDelivered(routed.run)
    return { status: 'delivered' }
  }

  async submitIsolated(work, {
    ownerId,
    taskId,
    objective,
    signal,
    onEvent,
  } = {}) {
    await this.start({ signal })
    const session = await this.client.newSession({
      cwd: this.directory,
      mcpServers: this.builtinMcp,
      ownerId,
      role: 'utility',
    })
    const permissionScopeId = `prompt_${randomUUID()}`
    const publish = event => this.publishWorkEvent(event, {
      taskId,
      ownerId,
      onEvent,
    })
    const run = {
      ownerId,
      coordinationRunId: taskId,
      coordinationRequestId: taskId,
      onEvent: publish,
      nativeToolCalls: new Map(),
      toolCalls: new Map(),
      messageStreams: {},
      receivedUpdate: false,
      allowDelegation: false,
    }
    session.ownerId = ownerId
    session.coordinationRunId = taskId
    session.onEvent = publish
    session.permissionScopeId = permissionScopeId
    try {
      // Configuration is part of the Session lifetime. If a required option
      // cannot be applied, the newly-created utility Session must still close.
      await this.configureSession(session, 'project')
      const result = assertCompletedAcpTurn(await this.client.prompt(
        session.sessionId,
        promptWithInputParts(
          clean(work?.instruction) || objective,
          work?.inputParts,
        ),
        {
          signal,
          timeoutMs: 0,
          onUpdate: update => this.onSessionUpdate(run, update),
        },
      ), {
        signal,
        label: `${this.label} 隔离 Session`,
        protocol: this.protocol,
      })
      const artifacts = artifactsFromAcpContentBlocks(result?.contentBlocks)
      if (!clean(result?.content) && !artifacts.length) {
        throw new AgentError('Isolated backend Session returned an empty response', {
          status: 502,
          protocol: this.protocol,
        })
      }
      return {
        content: clean(result?.content),
        artifacts,
        metadata: {
          backendRef: {
            provider: this.protocol,
            role: 'utility',
            sessionId: session.sessionId,
            directory: session.cwd || this.directory,
          },
        },
      }
    } finally {
      this.cancelPermissionsForScope(permissionScopeId)
      if (session.permissionScopeId === permissionScopeId) {
        session.permissionScopeId = null
      }
      if (typeof this.client.closeSession === 'function') {
        await this.client.closeSession(session.sessionId).catch(() => {})
      }
    }
  }

  async runCoordinator(message, {
    ownerId,
    coordinationRunId,
    coordinationRequestId,
    workObjective,
    conversation,
    projectTargets: savedProjectTargets = [],
    signal,
    onEvent,
  } = {}) {
    // Health polling and task dispatch share the ACP client's start promise.
    // The execution path additionally waits for an owned service endpoint, so
    // the first task after a cold start cannot race its bridge.
    await this.start({ signal })
    const runId = clean(coordinationRunId)
    const publish = event => this.publishWorkEvent(event, {
      taskId: runId,
      ownerId,
      onEvent,
    })
    try {
      const options = { ownerId, coordinationRunId, coordinationRequestId, workObjective,
        projectTargets: savedProjectTargets, signal, onEvent: publish }
      const continuingProjects = savedProjectTargets.length > 0
      const initial = await this.withCoordinatorTurn(
        continuingProjects ? projectUpdatePrompt(savedProjectTargets, message) : message,
        { ...options, conversation, phase: continuingProjects ? 'update' : 'execute' },
      )
      if (continuingProjects) {
        assertProjectUpdateDelivered(initial.run)
        this.workUpdates.get(runId)?.projectDelivery?.resolve({})
      }
      if (!initial.run.delegations.length) return this.resultEnvelope(initial)
      return await this.finishDelegatedWork(initial, { ...options, workObjective })
    } catch (error) {
      // A failed coordinator may have queued update turns. Stop and drain them
      // before releasing this Work; they must never outlive its cancellation handle.
      this.workControllers.get(runId)?.abort(error)
      await this.workUpdates.get(runId)?.controls
      throw error
    } finally {
      if (runId) {
        const run = this.coordinationRuns.get(runId)
        if (run) {
          run.closed = true
          // An initial/summary turn may fail after starting children. Never
          // leave those executions detached from their owning Work.
          await this.stopUnfinishedDelegations(run)
        }
        this.coordinationRuns.delete(runId)
      }
    }
  }

  async withCoordinatorTurn(message, options) {
    const lease = await this.acquireCoordinator(options.ownerId, {
      sessionId: this.workUpdates.get(clean(options.coordinationRunId))?.expectedSessionId,
      signal: options.signal,
    })
    try {
      options.signal?.throwIfAborted()
      return await this.coordinatorTurnWithRecovery(message, options)
    } finally {
      lease.release()
    }
  }

  async stopUnfinishedDelegations(run) {
    const active = run.delegations.filter(target => (
      ['running', 'cancelling'].includes(target.status)
      || (target.nativeCompletion && !target.remoteStopped && target.status !== 'completed')
    ))
    if (!active.length) return
    await waitForCancellation(Promise.all(active.map(async target => {
      await this.cancelDelegation({ delegation_id: target.id })
      await target.promise.catch(() => {})
    })), this.cancelTimeoutMs, this.protocol).catch(() => {
      // A timeout must not silently permit this Session to be resumed later.
      active.forEach(target => this.uncertainUpdateSessions.add(target.sessionId))
    })
  }

  async finishDelegatedWork(initial, options) {
    const { run, session } = initial
    const { signal, onEvent, workObjective } = options
    this.publishDelegation(run, { yielded: true })
    const updates = this.workUpdates.get(run.coordinationRunId)
    let outcomes
    while (true) {
      const targets = [...run.delegations]
      outcomes = await Promise.allSettled(targets.map(target => target.promise))
      const controls = updates?.controls
      await controls
      signal?.throwIfAborted()
      if (controls === updates?.controls
        && targets.length === run.delegations.length
        && targets.every((target, index) => target === run.delegations[index])) break
    }
    if (updates) updates.finalizing = true
    const failure = outcomes.find(outcome => outcome.status === 'rejected')
    if (failure && outcomes.length === 1) throw failure.reason
    const results = outcomes.map((outcome, index) => outcome.status === 'fulfilled'
      ? outcome.value : {
        ...delegationSummary([run.delegations[index]], session.sessionId),
        content: `执行失败：${clean(outcome.reason?.message || outcome.reason)}`,
        contentBlocks: [],
      })
    onEvent({
      type: BackendEventType.DELEGATION_COMPLETED,
      delegation: delegationSummary(results, session.sessionId),
    })
    // Bound each contribution, not just the joined prefix: a long first result
    // must not erase a later child's outcome (especially its failure).
    const resultBudget = Math.max(0, Math.floor(MAX_DELEGATION_RESULT_CHARS / results.length) - 2)
    const target = results.length === 1 ? results[0] : {
      content: results.map(result => `${result.title}\n${result.content}`.slice(0, resultBudget)).join('\n\n'),
      contentBlocks: results.flatMap(result => result.contentBlocks || []),
    }
    for (const artifact of artifactsFromAcpContentBlocks(target.contentBlocks)) {
      onEvent({ type: BackendEventType.ARTIFACT, artifact })
    }
    const final = await this.withCoordinatorTurn(this.delegationResultPrompt(target, workObjective), {
      ...options, delegations: run.delegations, phase: 'result',
    })
    if (failure) {
      throw new AgentError(`部分工作未完成：${clean(final.result.content)}`, { protocol: this.protocol })
    }
    return this.resultEnvelope(final, target, initial.result?.contentBlocks || [])
  }

  canRecoverDelegatedWork(task) {
    const saved = task?.delegation
    const targets = saved && ('targets' in saved ? saved.targets : [saved])
    return Boolean(this.nativeDelegationAdapter && Array.isArray(targets) && targets.length
      && targets.every(target => typeof target?.id === 'string' && target.id.trim()
        && typeof target?.sessionId === 'string' && target.sessionId.trim()))
  }

  async recoverDelegatedWork(task, {
    signal,
    onEvent,
  } = {}) {
    if (!this.canRecoverDelegatedWork(task)) {
      throw new AgentError(`${this.label} 无法恢复这项第三层任务`, {
        protocol: this.protocol,
      })
    }
    const ownerId = clean(task.ownerId)
    const coordinationRunId = clean(task.id)
    const publish = event => this.publishWorkEvent(event, {
      taskId: coordinationRunId,
      ownerId,
      onEvent,
    })
    const saved = task.delegation
    const execution = this.beginWork(coordinationRunId, ownerId, {
      signal, expectedSessionId: clean(saved.coordinatorSessionId),
    })
    signal = execution.signal
    execution.updates.started = true
    let lease
    let executionError
    try {
      lease = await this.acquireCoordinator(ownerId, {
        sessionId: clean(saved.coordinatorSessionId), signal,
      })
      const key = lease.key
      signal?.throwIfAborted()
      const run = {
        ownerId,
        coordinationRunId,
        coordinationRequestId: coordinationRunId,
        onEvent: publish,
        coordinatorKey: key,
        nativeToolCalls: new Map(),
        toolCalls: new Map(),
        initialPromptDone: true,
        objective: clean(task.objective),
        delegations: [],
        signal,
        turnClosed: true,
      }
      const registration = await this.ensureCoordinatorToolRegistration(ownerId, this.toolContext(run), key)
      const session = await this.ensureCoordinatorSession(ownerId, [
        ...(registration ? [registration.descriptor] : []), ...this.builtinMcp,
      ], key)
      if (saved.coordinatorSessionId && saved.coordinatorSessionId !== session.sessionId) {
        throw updateError('context_unavailable', '原后台会话已不可用，不能在其他会话中恢复委托。')
      }
      signal?.throwIfAborted()
      run.sessionId = session.sessionId
      for (const target of saved.targets || [saved]) {
        this.createNativeDelegation(run, {
          delegationId: clean(target.id),
          sessionId: clean(target.sessionId),
          directory: clean(target.directory || this.directory),
          title: bounded(target.title || task.objective, 160)
            || this.profile.defaultDelegationTitle
            || `${this.label} 项目任务`,
        })
      }
      if (coordinationRunId) this.coordinationRuns.set(coordinationRunId, run)
      lease.release()
      return await this.finishDelegatedWork({ run, session }, {
        ownerId, coordinationRunId, signal, onEvent: publish, workObjective: task.objective,
      })
    } catch (error) {
      executionError = error
      throw error
    } finally {
      const run = this.coordinationRuns.get(coordinationRunId)
      if (run) {
        run.closed = true
        await this.stopUnfinishedDelegations(run)
      }
      this.coordinationRuns.delete(coordinationRunId)
      lease?.release()
      execution.finish(executionError)
    }
  }

  async cancelWork(taskId, { ownerId } = {}) {
    const run = this.coordinationRuns.get(clean(taskId))
    const records = run?.delegations || []
    const updates = this.workUpdates.get(clean(taskId))
    if ((run && run.ownerId !== clean(ownerId)) || (updates && updates.ownerId !== clean(ownerId))) {
      throw new AgentError(`没有找到可取消的 ${this.label} 任务`, {
        protocol: this.protocol,
      })
    }
    // Stop the owning Work before child cancellation settles. Otherwise the
    // aggregate waiter could mistake cancelled children for a partial failure
    // and enqueue a new summary while cancel() is still waiting for them.
    this.workControllers.get(clean(taskId))?.abort(new AgentError('用户已取消这项工作', {
      status: 499, protocol: this.protocol,
    }))
    await Promise.all(records.map(record => this.cancelDelegation({ delegation_id: record.id })))

    // ACP cancellation interrupts execution but does not let a client rewrite
    // the backend-owned Session history. Record one terminal boundary only
    // when the request actually reached that persistent Session; it will be
    // projected into the next coordinator turn and acknowledged on success.
    if (run?.sessionId) {
      this.registry.appendReconciliation(
        run.coordinatorKey || coordinatorKey(ownerId, this.protocol),
        {
          kind: 'coordination_request_terminated',
          request_id: run.coordinationRequestId || clean(taskId),
          outcome: 'cancelled',
          ...(run.objective ? { objective: run.objective.slice(0, 2_000) } : {}),
          ...(records.length
            ? {
                targets: records.map(record => ({ delegation_id: record.id, target_session_id: record.sessionId })),
              }
            : {}),
          confirmed_at: new Date().toISOString(),
        },
      )
    }
    return {
      route: 'adapter',
      layer: records.length ? 'delegated' : 'coordinator',
      ...(records.length === 1
        ? {
            delegationId: records[0].id,
            sessionId: records[0].sessionId,
          }
        : {}),
    }
  }

  async cancel(taskId, options = {}) {
    const id = clean(taskId)
    const controller = this.workControllers.get(id)
    const updates = this.workUpdates.get(id)
    if (!controller && !this.coordinationRuns.has(id)) {
      return { taskId: id, state: 'not_found' }
    }
    return waitForCancellation((async () => {
      await this.cancelWork(id, options)
      // Keep the controller and Session lease until submit's finally has run.
      // A cancelled receipt must not race a continuation of the same task.
      const outcome = await updates?.settled.promise
      if (outcome?.error?.contextUncertain) throw outcome.error
      return { taskId: id, state: 'cancelled' }
    })(), this.cancelTimeoutMs, this.protocol)
  }

  async respondAuthorization(
    taskId,
    authorizationId,
    decision,
    { ownerId } = {},
  ) {
    const pending = this.pendingPermissions.get(clean(authorizationId))
    if (pending && clean(taskId) && pending.taskId !== clean(taskId)) {
      throw new AgentError('权限请求不属于这项工作', {
        status: 404,
        protocol: this.protocol,
      })
    }
    return this.resolveAuthorization(authorizationId, decision, { ownerId })
  }

  async respondInput(taskId, inputRequestId, response, { ownerId } = {}) {
    const pending = this.pendingInputs.get(clean(inputRequestId))
    if (pending && clean(taskId) && pending.taskId !== clean(taskId)) {
      throw new AgentError('输入请求不属于这项工作', {
        status: 404,
        protocol: this.protocol,
      })
    }
    return this.inputBroker.respond(inputRequestId, response, { ownerId })
  }

  async queryDelegatedWork(taskId, _question, { ownerId } = {}) {
    const run = this.coordinationRuns.get(clean(taskId))
    if (!run?.delegations.length || run.ownerId !== clean(ownerId)) {
      throw new AgentError(`没有找到对应的 ${this.label} 项目任务`, {
        protocol: this.protocol,
      })
    }
    const status = this.status(taskId, { ownerId })
    const latest = status.activity?.at(-1)
    const latestDetail = bounded(
      latest?.detail || latest?.tool || latest?.kind,
      240,
    )
    const answer = status.state === 'completed'
      ? `这项工作已经完成：${clean(status.result)}`
      : status.state === 'failed'
        ? `这项工作已经失败：${clean(status.error)}`
        : status.state === 'cancelled'
          ? '这项工作已经取消。'
          : latestDetail
            ? `这项工作仍在执行中，最近进展：${latestDetail}`
            : '这项工作仍在执行中，当前没有新的详细进展。'
    return {
      content: JSON.stringify({
        task_id: clean(taskId),
        state: 'completed',
        mode: 'respond',
        result: answer,
      }),
      protocol: this.protocol,
      metadata: {
        statusSource: 'gateway',
        recentUpdates: status.activity || [],
        delegation: delegationSummary(run.delegations, run.sessionId),
      },
    }
  }

  async uiUrl(ownerId) {
    if (!this.profile.uiUrl) return null
    const key = coordinatorKey(ownerId, this.protocol)
    const session = this.coordinatorSessions.get(key) || this.registry.get(key)
    return this.profile.uiUrl({
      baseUrl: this.baseUrl,
      sessionId: session?.sessionId || null,
      ownerId,
    })
  }

  close() {
    this.closePromise ||= Promise.resolve().then(() => this.closeAfterCancellation())
    return this.closePromise
  }

  async closeAfterCancellation() {
    this.coordinatorQueue.close()
    const executions = [...this.workUpdates.values()]
    const targets = [...this.coordinationRuns.values()].flatMap(run => run.delegations || [])
    for (const controller of this.workControllers.values()) {
      controller.abort(new AgentError('后台 Agent 已关闭', {
        status: 503,
        protocol: this.protocol,
      }))
    }
    for (const target of targets) {
      target.controller.abort(new Error(`${this.label} backend is shutting down`))
    }
    this.permissionBroker.cancelAll()
    this.inputBroker.cancelAll()
    let cancellationError
    try {
      await waitForCancellation(Promise.all([
        ...targets.map(target => this.cancelDelegation({ delegation_id: target.id })),
        ...executions.map(async execution => {
          const outcome = await execution.settled.promise
          if (outcome?.error?.contextUncertain) throw outcome.error
        }),
      ]), this.cancelTimeoutMs, this.protocol)
    } catch (error) {
      cancellationError = error
    }
    // Closing the transport is also necessary for clients whose pending prompt
    // settles only on disconnect. Do not wait forever or mistake that local
    // cleanup for confirmation that an independently hosted native run stopped.
    await Promise.allSettled(
      [...this.coordinatorToolRegistrationPromises.values()],
    )
    const registrations = [...this.coordinatorToolRegistrations.values()]
    this.coordinatorToolRegistrations.clear()
    await Promise.allSettled(registrations.map(registration => (
      Promise.resolve().then(() => registration.release())
    )))
    await Promise.allSettled([
      this.sessionToolServer.close(),
      this.client.close(),
    ])
    await this.builtinMcpLifecycle.close()
    this.workEventListeners.clear()
    if (cancellationError) {
      this.runtimeState.failed(cancellationError)
      throw cancellationError
    }
    this.uncertainUpdateSessions.clear()
    this.runtimeState.stopped()
  }
}
