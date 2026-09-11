import { randomBytes } from 'node:crypto'
import {
  MuseClient,
  readSessionDurability,
  spawnMspConnection,
} from '@muse-code/sdk'
import { parseDataUrl } from '../../../../../shared/input-parts.mjs'
import { backendEnvironment } from '../../../../../shared/backend/environment.mjs'
import { findExecutable } from '../../../../../shared/backend/setup.mjs'
import { defineBackendAdapter } from '../../backend-adapter-sdk.mjs'
import { backendInstructionFromWork } from '../../backend-work-input.mjs'
import { BackendEventType, backendEvent } from '../../../core/backend-events.mjs'
import {
  AuthorizationStatus,
  normalizeAuthorization,
  resolveAuthorization,
} from '../../../core/work-authorization.mjs'
import {
  InputRequestStatus,
  normalizeInputRequest,
  resolveInputRequest,
} from '../../../core/work-input-request.mjs'
import { AgentError } from '../../agent-error.mjs'

const DEFAULT_MUSE_ARGS = Object.freeze(['serve'])
const INPUT_POLL_MS = 75
const MAX_RESULT_CHARS = 1_000_000
const MAX_ACTIVITY_CHARS = 1_000

function clean(value) {
  return String(value || '').trim()
}

function bounded(value, max = MAX_ACTIVITY_CHARS) {
  return clean(value).replaceAll('\u0000', '').slice(0, max)
}

function publicId(prefix) {
  return `${prefix}_${randomBytes(9).toString('base64url')}`
}

function cancellationError(taskId, cause) {
  const error = new AgentError(`Muse Code Task ${taskId} was cancelled`, {
    status: 499,
    protocol: 'muse',
  })
  error.code = 'WORK_CANCELLED'
  if (cause !== undefined) error.cause = cause
  return error
}

function failureMessage(error) {
  return bounded(error?.message || error, 2_000) || 'Unknown Muse Code error'
}

function wait(ms) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

function abortPromise(signal) {
  if (!signal) return new Promise(() => {})
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

function taskInput(work) {
  const instruction = backendInstructionFromWork(work)
  if (!instruction) return []
  const input = [{ type: 'text', text: instruction }]
  for (const part of Array.isArray(work?.inputParts) ? work.inputParts : []) {
    if (part?.type !== 'file') continue
    const parsed = parseDataUrl(part.url)
    const mediaType = clean(part.mime || part.mimeType || parsed?.mimeType)
    if (!parsed || !mediaType.startsWith('image/')) {
      throw new AgentError(
        'Muse Code MSP currently accepts only inline image attachments',
        { status: 400, protocol: 'muse' },
      )
    }
    input.push({
      type: 'image',
      mediaType,
      base64Data: parsed.data,
    })
  }
  return input
}

function itemStatus(value) {
  switch (value) {
    case 'completed': return 'completed'
    case 'failed':
    case 'rejected':
    case 'timedOut': return 'failed'
    case 'cancelled': return 'cancelled'
    default: return 'running'
  }
}

function itemActivity(item) {
  const common = {
    id: `muse-item-${bounded(item?.itemId, 160)}`,
    status: itemStatus(item?.status),
  }
  if (item?.kind === 'reasoning') {
    return { ...common, kind: 'thinking', label: 'Muse Code reasoning' }
  }
  if (item?.kind === 'toolCall' || item?.kind === 'userShell') {
    return {
      ...common,
      kind: 'tool',
      tool: bounded(item.tool || item.commandText, 160) || 'Muse Code tool',
      label: bounded(item.tool, 160) || 'Muse Code tool',
      ...(bounded(item.failureReason || item.visibleOutput)
        ? { detail: bounded(item.failureReason || item.visibleOutput) }
        : {}),
    }
  }
  if (['subagent', 'workflow', 'reminderChild'].includes(item?.kind)) {
    return {
      ...common,
      kind: item.kind === 'workflow' ? 'plan' : 'session',
      label: item.kind === 'workflow' ? 'Muse Code workflow' : 'Muse Code subagent',
      ...(bounded(item.message || item.fallbackText || item.objective)
        ? { detail: bounded(item.message || item.fallbackText || item.objective) }
        : {}),
    }
  }
  if (item?.kind === 'compaction') {
    return { ...common, kind: 'status', label: 'Muse Code context compaction' }
  }
  return null
}

function approvalOperation(request) {
  const subject = request?.subject || {}
  const command = bounded(subject.command, 1_200)
  const path = bounded(subject.path || subject.target, 600)
  const title = bounded(
    subject.toolName || request?.toolName || subject.kind || 'Muse Code operation',
    160,
  )
  return {
    title,
    kind: bounded(subject.kind || request?.toolName, 80) || 'unknown',
    ...(command ? { command } : {}),
    ...(path ? { path } : {}),
    ...(bounded(subject.host, 300)
      ? { description: `Host: ${bounded(subject.host, 300)}` }
      : {}),
  }
}

function approvalScope(request) {
  const scopes = new Set(
    (request?.availableChoices || []).map(choice => choice?.scope),
  )
  if (scopes.has('localPersistent')) return 'persistent'
  if (scopes.has('session')) return 'session'
  return 'once'
}

function choiceFor(request, decision) {
  const choices = Array.isArray(request?.availableChoices)
    ? request.availableChoices
    : []
  if (decision === 'reject') {
    return choices.find(choice => clean(choice?.decision).startsWith('denied'))
      || choices.find(choice => choice?.decision === 'abort')
      || null
  }
  const approved = choices.filter(choice => (
    clean(choice?.decision).startsWith('approved')
  ))
  // Gateway task/session grants are intentionally local to the frontend
  // Session. Never turn them into a provider-persistent Muse policy.
  return approved.find(choice => choice?.scope === 'once') || approved[0] || null
}

function inputPrompt(request) {
  return (request?.questions || [])
    .map(question => bounded(question?.question, 1_000))
    .filter(Boolean)
    .join('\n') || 'Muse Code needs more information.'
}

function inputSchema(request) {
  return {
    questions: (request?.questions || []).map(question => ({
      id: bounded(question?.id, 160),
      header: bounded(question?.header, 160),
      question: bounded(question?.question, 1_000),
      selection: question?.selection,
      options: (question?.options || []).map(option => ({
        label: bounded(option?.label, 300),
        ...(bounded(option?.description, 600)
          ? { description: bounded(option.description, 600) }
          : {}),
      })),
    })),
  }
}

function selectedValue(values, questionId) {
  if (!values || typeof values !== 'object') return undefined
  return values[questionId]
}

function answerForQuestion(question, value, fallbackText) {
  const common = { questionId: question.id }
  if (question?.selection?.mode === 'multiple') {
    const labels = Array.isArray(value)
      ? value.map(clean).filter(Boolean)
      : clean(value) ? [clean(value)] : []
    return labels.length ? { ...common, selectedLabels: labels } : null
  }
  if (clean(value)) return { ...common, selectedLabel: clean(value) }
  if (clean(fallbackText)) return { ...common, freeText: bounded(fallbackText, 500) }
  return null
}

export async function createOfficialMuseClient({
  museBin = 'muse',
  args = DEFAULT_MUSE_ARGS,
  directory = process.cwd(),
  env = process.env,
  onStderr,
  shutdownTimeoutMs,
} = {}) {
  const handshake = spawnMspConnection({
    command: museBin,
    args,
    cwd: directory,
    env,
    onStderr,
    shutdownTimeoutMs,
  })
  let host
  try {
    host = await handshake.initialize({
      clientInfo: {
        name: 'qwen_audio_agent',
        title: 'Qwen Audio Agent',
        version: MUSE_BACKEND_ADAPTER_VERSION,
      },
    })
  } catch (error) {
    await handshake.close().catch(() => {})
    throw error
  }
  const client = new MuseClient(host.connection, {
    durability: readSessionDurability(host.initializeResult),
    host,
  })
  return {
    client,
    connection: host.connection,
    initializeResult: host.initializeResult,
  }
}

export class MuseBackendAdapter {
  constructor({
    directory = process.cwd(),
    workspaceRoot = directory,
    model = '',
    museBin = 'muse',
    args = DEFAULT_MUSE_ARGS,
    permissionMode = 'native',
    timeoutMs = 300_000,
    shutdownTimeoutMs = 30_000,
    env = process.env,
    clientFactory = createOfficialMuseClient,
  } = {}) {
    this.protocol = 'muse'
    this.label = 'Muse Code'
    this.directory = directory
    this.workspaceRoot = clean(workspaceRoot) || directory
    this.model = clean(model)
    this.museBin = clean(museBin) || 'muse'
    this.args = Array.isArray(args) ? [...args] : [...DEFAULT_MUSE_ARGS]
    this.permissionMode = permissionMode === 'full' ? 'full' : 'native'
    this.timeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : 0
    this.shutdownTimeoutMs = Number(shutdownTimeoutMs) >= 0
      ? Number(shutdownTimeoutMs)
      : 30_000
    this.env = backendEnvironment('muse', { env })
    this.clientFactory = clientFactory
    this.client = null
    this.connection = null
    this.initializeResult = null
    this.startPromise = null
    this.ready = false
    this.closed = false
    this.failure = null
    this.stderr = ''
    this.sessions = new Map()
    this.sessionPromises = new Map()
    this.active = new Map()
    this.pendingAuthorizations = new Map()
    this.resolvedAuthorizations = new Map()
    this.pendingInputs = new Map()
    this.listeners = new Set()
  }

  describe() {
    return {
      configured: true,
      enabled: true,
      protocol: this.protocol,
      kind: this.protocol,
      label: this.label,
      transport: 'msp-stdio',
      model: this.model || null,
      directory: this.directory,
      workspaceRoot: this.workspaceRoot,
      permissionMode: this.permissionMode,
      sessionDurability: this.initializeResult?.sessionDurability || null,
      capabilities: {
        cancel: true,
        authorization: true,
        inputRequests: 'msp',
        taskUpdates: 'native',
        nativeSessionHistory: false,
        backendUi: false,
        delegation: false,
        sessionMcp: false,
      },
    }
  }

  runtimeStatus() {
    return {
      ok: this.ready && !this.closed,
      status: this.ready && !this.closed
        ? 'ready'
        : this.closed ? 'stopped' : this.failure ? 'failed' : 'not_started',
      protocol: this.protocol,
      ...(this.failure ? { error: failureMessage(this.failure) } : {}),
    }
  }

  async start() {
    if (this.closed) throw new AgentError('Muse Code adapter is closed', {
      status: 503,
      protocol: this.protocol,
    })
    if (this.ready) return this.runtimeStatus()
    if (this.startPromise) return this.startPromise
    this.startPromise = (async () => {
      try {
        if (this.clientFactory === createOfficialMuseClient) {
          const executable = findExecutable(this.museBin, {
            env: this.env,
            platform: process.platform,
          })
          if (!executable) {
            const error = new AgentError(
              `未找到 Muse Code 可执行文件：${this.museBin}`,
              { status: 503, protocol: this.protocol },
            )
            error.code = 'MUSE_CODE_NOT_FOUND'
            throw error
          }
        }
        const created = await this.clientFactory({
          museBin: this.museBin,
          args: this.args,
          directory: this.directory,
          env: this.env,
          shutdownTimeoutMs: this.shutdownTimeoutMs,
          onStderr: chunk => {
            this.stderr = `${this.stderr}${String(chunk || '')}`.slice(-8_192)
          },
        })
        this.client = created?.client || created
        this.connection = created?.connection || this.client?.connection || null
        this.initializeResult = created?.initializeResult || null
        if (!this.client || typeof this.client.startSession !== 'function') {
          throw new TypeError('Muse client factory returned an invalid client')
        }
        this.ready = true
        this.failure = null
        return this.runtimeStatus()
      } catch (error) {
        this.failure = error
        this.ready = false
        throw error
      } finally {
        this.startPromise = null
      }
    })()
    return this.startPromise
  }

  async health() {
    if (!this.ready && !this.closed) {
      try {
        await this.start()
      } catch {
        return this.runtimeStatus()
      }
    }
    return this.runtimeStatus()
  }

  publish(event, record) {
    try {
      record?.onEvent?.(event)
    } catch {
      // A per-Task observer must not interrupt Muse execution.
    }
    const published = {
      ...event,
      taskId: record?.taskId || null,
      ownerId: record?.ownerId || null,
    }
    for (const listener of this.listeners) {
      try {
        listener(published)
      } catch {
        // Subscribers are isolated from the adapter and one another.
      }
    }
  }

  subscribe(listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('Backend event listener must be a function')
    }
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async sessionFor(ownerId) {
    if (this.sessions.has(ownerId)) return this.sessions.get(ownerId)
    if (this.sessionPromises.has(ownerId)) return this.sessionPromises.get(ownerId)
    const pending = (async () => {
      const session = await this.client.startSession({
        workspaceRoot: this.workspaceRoot,
        ...(this.model ? { modelId: this.model } : {}),
        ...(this.permissionMode === 'full' ? { approvalMode: 'allowAll' } : {}),
      })
      const state = { ownerId, session, records: new Set() }
      session.onApproval(request => this.handleApproval(state, request))
      session.onApprovalError(failure => {
        const pendingAuthorization = [...this.pendingAuthorizations.values()]
          .find(record => record.request?.approvalId === failure?.approvalId)
        if (!pendingAuthorization) return
        this.publish(backendEvent(BackendEventType.MESSAGE, {
          message: `Muse Code permission failed: ${failureMessage(failure?.error || failure?.kind)}`,
        }), pendingAuthorization.task)
      })
      this.sessions.set(ownerId, state)
      return state
    })().finally(() => this.sessionPromises.delete(ownerId))
    this.sessionPromises.set(ownerId, pending)
    return pending
  }

  recordForSessionRequest(state, request) {
    return [...state.records].find(record => record.turnId === request?.turnId)
      || (state.records.size === 1 ? [...state.records][0] : null)
  }

  async handleApproval(state, request) {
    const task = this.recordForSessionRequest(state, request)
    if (!task) throw new Error('Muse approval is not associated with an active Task')
    if (this.permissionMode === 'full') {
      const choice = choiceFor(request, 'once')
      if (!choice) throw new Error('Muse Code did not offer an approval choice')
      return { choiceId: choice.choiceId }
    }
    const id = publicId('auth')
    const operation = approvalOperation(request)
    const permission = normalizeAuthorization({
      id,
      taskId: task.taskId,
      status: AuthorizationStatus.PENDING,
      category: operation.kind,
      summary: [operation.title, operation.command || operation.path]
        .filter(Boolean).join(': '),
      approvalScope: approvalScope(request),
      operation,
    })
    const pending = Promise.withResolvers()
    this.pendingAuthorizations.set(id, {
      id,
      task,
      request,
      permission,
      pending,
    })
    this.publish(backendEvent(BackendEventType.AUTHORIZATION_REQUESTED, {
      permission,
    }), task)
    return pending.promise
  }

  async respondAuthorization(
    taskId,
    authorizationId,
    decision,
    { ownerId } = {},
  ) {
    const id = clean(authorizationId)
    const record = this.pendingAuthorizations.get(id)
    if (!record) {
      const resolved = this.resolvedAuthorizations.get(id)
      if (resolved?.ownerId === clean(ownerId)) return resolved.permission
    }
    if (
      !record
      || record.task.taskId !== clean(taskId)
      || record.task.ownerId !== clean(ownerId)
    ) {
      throw new AgentError('Muse Code permission is missing or belongs to another Task', {
        status: 404,
        protocol: this.protocol,
      })
    }
    const normalizedDecision = decision === 'once' || decision === 'always'
      ? decision
      : 'reject'
    const choice = choiceFor(record.request, normalizedDecision)
    if (!choice) {
      throw new AgentError('Muse Code did not offer the requested permission choice', {
        status: 409,
        protocol: this.protocol,
      })
    }
    this.pendingAuthorizations.delete(id)
    record.pending.resolve({ choiceId: choice.choiceId })
    const permission = resolveAuthorization(
      record.permission,
      normalizedDecision === 'reject'
        ? AuthorizationStatus.DENIED
        : AuthorizationStatus.APPROVED,
    )
    this.publish(backendEvent(BackendEventType.AUTHORIZATION_RESOLVED, {
      permission,
    }), record.task)
    this.resolvedAuthorizations.set(id, {
      ownerId: record.task.ownerId,
      permission,
    })
    while (this.resolvedAuthorizations.size > 200) {
      this.resolvedAuthorizations.delete(
        this.resolvedAuthorizations.keys().next().value,
      )
    }
    return permission
  }

  projectInputRequest(task, request) {
    const id = publicId('input')
    const form = request?.questions?.some(question => (
      Array.isArray(question?.options) && question.options.length
    ))
    const input = normalizeInputRequest({
      id,
      taskId: task.taskId,
      status: InputRequestStatus.PENDING,
      kind: 'input',
      mode: form ? 'form' : 'text',
      prompt: inputPrompt(request),
      schema: inputSchema(request),
    })
    return { id, task, request, input }
  }

  scanInputRequests(task) {
    const requests = task.sessionState.session.fold.pendingUserInputs()
    for (const request of requests) {
      if (request.turnId !== task.turnId || task.seenInputIds.has(request.userInputId)) {
        continue
      }
      task.seenInputIds.add(request.userInputId)
      const record = this.projectInputRequest(task, request)
      this.pendingInputs.set(record.id, record)
      this.publish(backendEvent(BackendEventType.INPUT_REQUESTED, {
        input: record.input,
      }), task)
    }
  }

  async monitorInputRequests(task, completed) {
    let done = false
    Promise.resolve(completed).finally(() => { done = true }).catch(() => {})
    while (!done && this.active.get(task.taskId) === task) {
      this.scanInputRequests(task)
      await wait(INPUT_POLL_MS)
    }
  }

  async respondInput(
    taskId,
    inputRequestId,
    response = {},
    { ownerId } = {},
  ) {
    const record = this.pendingInputs.get(clean(inputRequestId))
    if (
      !record
      || record.task.taskId !== clean(taskId)
      || record.task.ownerId !== clean(ownerId)
    ) {
      throw new AgentError('Muse Code input request is missing or belongs to another Task', {
        status: 404,
        protocol: this.protocol,
      })
    }
    if (!this.connection?.command || !this.connection?.mintCommandId) {
      throw new AgentError('Muse Code client does not expose the MSP command connection', {
        status: 501,
        protocol: this.protocol,
      })
    }
    const action = ['accept', 'decline', 'cancel'].includes(response.action)
      ? response.action
      : 'accept'
    const commandId = this.connection.mintCommandId()
    const common = {
      commandId,
      sessionId: record.request.sessionId,
      userInputId: record.request.userInputId,
    }
    if (action !== 'accept') {
      await this.connection.command('userInput/cancel', {
        ...common,
        reason: bounded(response.text, 500)
          || (action === 'decline' ? 'User declined to answer' : 'User cancelled'),
      }, { commandId })
    } else {
      const answers = (record.request.questions || [])
        .map(question => answerForQuestion(
          question,
          selectedValue(response.values, question.id),
          record.request.questions.length === 1 ? response.text : '',
        ))
        .filter(Boolean)
      if (answers.length === record.request.questions.length) {
        await this.connection.command('userInput/answer', {
          ...common,
          answers,
        }, { commandId })
      } else {
        await this.connection.command('userInput/clarify', {
          ...common,
          clarification: {
            format: 'text',
            content: bounded(response.text, 500) || 'Please clarify the questions.',
          },
        }, { commandId })
      }
    }
    this.pendingInputs.delete(record.id)
    const input = resolveInputRequest(
      record.input,
      action === 'accept'
        ? InputRequestStatus.ACCEPTED
        : action === 'decline'
          ? InputRequestStatus.DECLINED
          : InputRequestStatus.CANCELLED,
    )
    this.publish(backendEvent(BackendEventType.INPUT_RESOLVED, { input }), record.task)
    return input
  }

  updateItem(task, item) {
    const digest = JSON.stringify(item)
    if (task.itemDigests.get(item.itemId) === digest) return
    task.itemDigests.set(item.itemId, digest)
    task.items.set(item.itemId, item)
    const activity = itemActivity(item)
    if (activity) {
      task.activities.set(activity.id, activity)
      this.publish(backendEvent(BackendEventType.ACTIVITY, { activity }), task)
    }
    if (item.kind === 'agentMessage' && item.status !== 'inProgress' && clean(item.text)) {
      this.publish(backendEvent(BackendEventType.MESSAGE, {
        message: bounded(item.text, 12_000),
      }), task)
    }
  }

  async consumeItems(task, turn) {
    for await (const item of turn.items()) this.updateItem(task, item)
  }

  resultFor(task) {
    const content = [...task.items.values()]
      .filter(item => item.kind === 'agentMessage' && clean(item.text))
      .map(item => clean(item.text))
      .join('\n\n')
      .slice(0, MAX_RESULT_CHARS)
    return {
      content: content || 'Muse Code completed the task.',
      artifacts: [],
    }
  }

  assertTurnCompleted(task, outcome) {
    if (outcome?.kind === 'unqueued') throw cancellationError(task.taskId)
    if (outcome?.kind === 'terminalUnknown') {
      throw new AgentError('Muse Code host exited before the Task terminal was known', {
        status: 502,
        protocol: this.protocol,
      })
    }
    const terminal = outcome?.params?.terminal
    if (terminal === 'completed') return
    if (terminal === 'cancelled') throw cancellationError(task.taskId)
    throw new AgentError(
      bounded(outcome?.params?.error?.message || outcome?.params?.reason, 2_000)
        || `Muse Code Task ended with ${terminal || 'an unknown terminal'}`,
      { status: 502, protocol: this.protocol },
    )
  }

  async submit(work, { signal, onEvent } = {}) {
    const taskId = clean(work?.id)
    const ownerId = clean(work?.ownerId)
    const input = taskInput(work)
    if (!taskId || !ownerId || !input.length) {
      throw new AgentError('Backend submit requires task id, owner and input', {
        status: 400,
        protocol: this.protocol,
      })
    }
    if (this.active.has(taskId)) {
      throw new AgentError(`Task ${taskId} is already active`, {
        status: 409,
        protocol: this.protocol,
      })
    }
    await this.start()
    const sessionState = await this.sessionFor(ownerId)
    const controller = new AbortController()
    const timeoutSignal = this.timeoutMs > 0
      ? AbortSignal.timeout(this.timeoutMs)
      : null
    const workSignal = AbortSignal.any(
      [signal, controller.signal, timeoutSignal].filter(Boolean),
    )
    const task = {
      taskId,
      ownerId,
      onEvent,
      controller,
      sessionState,
      turnId: '',
      activities: new Map(),
      items: new Map(),
      itemDigests: new Map(),
      seenInputIds: new Set(),
      cancelRequested: false,
    }
    this.active.set(taskId, task)
    sessionState.records.add(task)
    this.publish(backendEvent(BackendEventType.ACTIVITY, {
      activity: {
        id: 'muse-status',
        kind: 'status',
        status: 'running',
        label: 'Muse Code started',
      },
    }), task)
    try {
      const turn = await sessionState.session.sendUserTurn({
        input,
        displayText: backendInstructionFromWork(work),
        ifBusy: 'queue',
      })
      task.turnId = turn.turnId
      const consuming = this.consumeItems(task, turn)
      consuming.catch(() => {})
      const monitoring = this.monitorInputRequests(task, turn.completed)
      monitoring.catch(() => {})
      if (workSignal.aborted) this.cancelTurn(task).catch(() => {})
      else {
        workSignal.addEventListener('abort', () => {
          this.cancelTurn(task).catch(() => {})
        }, { once: true })
      }
      const outcome = await Promise.race([
        turn.completed,
        abortPromise(workSignal),
      ])
      this.assertTurnCompleted(task, outcome)
      await consuming
      return this.resultFor(task)
    } catch (error) {
      if (workSignal.aborted) throw cancellationError(taskId, error)
      throw error
    } finally {
      this.settleTaskInteractions(task)
      sessionState.records.delete(task)
      if (this.active.get(taskId) === task) this.active.delete(taskId)
    }
  }

  settleTaskInteractions(task) {
    for (const [id, record] of this.pendingAuthorizations) {
      if (record.task !== task) continue
      this.pendingAuthorizations.delete(id)
      const choice = choiceFor(record.request, 'reject')
      if (choice) record.pending.resolve({ choiceId: choice.choiceId })
      else record.pending.reject(new Error('Muse approval ended with its Task'))
    }
    for (const [id, record] of this.pendingInputs) {
      if (record.task === task) this.pendingInputs.delete(id)
    }
  }

  async cancelTurn(task) {
    if (!task?.turnId || !this.connection?.command || !this.connection?.mintCommandId) {
      return
    }
    if (task.cancelRequested) return
    task.cancelRequested = true
    const commandId = this.connection.mintCommandId()
    await this.connection.command('turn/cancel', {
      commandId,
      sessionId: task.sessionState.session.sessionId,
      turnId: task.turnId,
    }, { commandId })
  }

  status(taskId, { ownerId } = {}) {
    const id = clean(taskId)
    if (!id) return this.runtimeStatus()
    const task = this.active.get(id)
    if (!task || (ownerId && clean(ownerId) !== task.ownerId)) {
      return { taskId: id, state: 'not_found', activity: [] }
    }
    return {
      taskId: id,
      state: 'working',
      activity: [...task.activities.values()],
    }
  }

  async cancel(taskId, { ownerId } = {}) {
    const id = clean(taskId)
    const task = this.active.get(id)
    if (!task) return { taskId: id, state: 'not_found' }
    if (ownerId && clean(ownerId) !== task.ownerId) {
      throw new AgentError('Cannot cancel Muse Code work owned by another user', {
        status: 404,
        protocol: this.protocol,
      })
    }
    task.controller.abort(cancellationError(id))
    return { taskId: id, state: 'cancelled' }
  }

  async close() {
    if (this.closed) return
    this.closed = true
    for (const task of this.active.values()) {
      task.controller.abort(cancellationError(task.taskId))
      this.settleTaskInteractions(task)
    }
    this.active.clear()
    this.sessions.clear()
    this.sessionPromises.clear()
    this.listeners.clear()
    if (this.client?.close) await this.client.close()
    this.client = null
    this.connection = null
    this.ready = false
  }
}

export function createMuseBackendAdapter(options) {
  return defineBackendAdapter(new MuseBackendAdapter(options), {
    name: 'Muse Code backend adapter',
  })
}

export const MUSE_BACKEND_ADAPTER_VERSION = '1.0.0'
