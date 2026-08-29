import { randomUUID } from 'node:crypto'
import {
  Role,
  TaskState,
} from '@a2a-js/sdk'
import {
  ClientFactory,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  RestTransportFactory,
} from '@a2a-js/sdk/client'
import { parseDataUrl } from '../../../shared/input-parts.mjs'
import { defineBackendAdapter } from './backend-adapter-sdk.mjs'
import { backendInstructionFromWork } from './backend-work-input.mjs'
import { BackendEventType, backendEvent } from '../core/backend-events.mjs'
import {
  InputRequestStatus,
  normalizeInputRequest,
  resolveInputRequest,
} from '../core/work-input-request.mjs'

const DEFAULT_POLL_INTERVAL_MS = 1_000
const DEFAULT_TIMEOUT_MS = 0
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const MAX_TEXT_CHARS = 1_000_000
const MAX_ARTIFACTS = 32
const MAX_ARTIFACT_PARTS = 64
const DEFAULT_OUTPUT_MODES = Object.freeze([
  'text/plain',
  'text/markdown',
  'application/json',
  'image/png',
  'image/jpeg',
])

const TERMINAL_STATES = new Set([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED,
])

const INTERRUPTED_STATES = new Set([
  TaskState.TASK_STATE_INPUT_REQUIRED,
  TaskState.TASK_STATE_AUTH_REQUIRED,
])

function clean(value) {
  return String(value || '').trim()
}

function bounded(value, max = 4_000) {
  return clean(value).slice(0, max)
}

function positiveNumber(value, fallback, minimum) {
  const number = Number(value)
  return Number.isFinite(number) && number >= minimum ? number : fallback
}

function nonNegativeNumber(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : fallback
}

function cancellationError(taskId, cause) {
  const error = new A2ABackendError(`Task ${taskId} was cancelled`, {
    code: 'WORK_CANCELLED',
    cause,
  })
  return error
}

function asErrorMessage(error) {
  return bounded(error?.message || error, 1_000) || 'Unknown A2A error'
}

function safeUrl(value, label) {
  const input = clean(value)
  if (!input) return ''
  let url
  try {
    url = new URL(input)
  } catch {
    throw new TypeError(`${label} must be an absolute URL`)
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new TypeError(`${label} must use HTTP or HTTPS`)
  }
  if (url.username || url.password) {
    throw new TypeError(`${label} must not contain credentials`)
  }
  return url.toString()
}

function requestHeaders(input, init) {
  const result = new Headers(
    typeof Request !== 'undefined' && input instanceof Request
      ? input.headers
      : undefined,
  )
  new Headers(init?.headers).forEach((value, key) => result.set(key, value))
  return result
}

function authenticatedFetch({ fetchImpl, headers, token, requestTimeoutMs }) {
  const base = fetchImpl || globalThis.fetch
  if (typeof base !== 'function') {
    throw new TypeError('A2A adapter requires a Fetch API implementation')
  }
  return async (input, init = {}) => {
    const configured = typeof headers === 'function'
      ? await headers()
      : headers
    const merged = requestHeaders(input, init)
    if (clean(token) && !merged.has('authorization')) {
      merged.set('authorization', `Bearer ${clean(token)}`)
    }
    new Headers(configured).forEach((value, key) => merged.set(key, value))
    // Active A2A operations already carry the Task cancellation signal and
    // may legitimately stream for a long time. Bound only unscoped requests
    // such as Agent Card discovery.
    const requestSignal = init.signal || (
      requestTimeoutMs > 0
        ? AbortSignal.timeout(requestTimeoutMs)
        : undefined
    )
    return base(input, {
      ...init,
      headers: merged,
      ...(requestSignal ? { signal: requestSignal } : {}),
    })
  }
}

async function createOfficialClient({
  agentCard,
  agentCardUrl,
  fetchImpl,
  legacyCompat,
  acceptedOutputModes,
}) {
  const compatibility = legacyCompat ? { enabled: true } : undefined
  const transports = [
    new JsonRpcTransportFactory({
      fetchImpl,
      ...(compatibility ? { legacyCompat: compatibility } : {}),
    }),
    new RestTransportFactory({
      fetchImpl,
      ...(compatibility ? { legacyCompat: compatibility } : {}),
    }),
  ]
  const resolver = new DefaultAgentCardResolver({
    fetchImpl,
    ...(compatibility ? { legacyCompat: compatibility } : {}),
  })
  const factory = new ClientFactory({
    transports,
    clientConfig: {
      polling: true,
      acceptedOutputModes,
    },
    cardResolver: resolver,
  })
  const resolvedCard = agentCard || await resolver.resolve(agentCardUrl, '')
  const client = await factory.createFromAgentCard(resolvedCard)
  return {
    client,
    agentCard: resolvedCard,
  }
}

function textContent(part) {
  if (part?.content?.$case === 'text') {
    return bounded(part.content.value, MAX_TEXT_CHARS)
  }
  return bounded(part?.text, MAX_TEXT_CHARS)
}

function partContent(part) {
  const mediaType = clean(part?.mediaType || part?.mimeType)
  const filename = clean(part?.filename)
  const common = {
    ...(mediaType ? { mediaType } : {}),
    ...(filename ? { filename } : {}),
  }
  if (part?.content?.$case === 'text' || part?.text !== undefined) {
    const text = textContent(part)
    return text ? { text, ...common } : null
  }
  if (part?.content?.$case === 'raw' || part?.raw !== undefined) {
    const value = part?.content?.$case === 'raw'
      ? part.content.value
      : part.raw
    const raw = Buffer.isBuffer(value)
      ? value.toString('base64')
      : value instanceof Uint8Array
        ? Buffer.from(value).toString('base64')
        : clean(value)
    return raw ? { raw, ...common } : null
  }
  if (part?.content?.$case === 'url' || part?.url !== undefined) {
    const url = clean(
      part?.content?.$case === 'url' ? part.content.value : part.url,
    )
    return url ? { url, ...common } : null
  }
  if (part?.content?.$case === 'data' || part?.data !== undefined) {
    return {
      data: part?.content?.$case === 'data'
        ? part.content.value
        : part.data,
      ...common,
    }
  }
  return null
}

function messageText(message) {
  return (Array.isArray(message?.parts) ? message.parts : [])
    .map(textContent)
    .filter(Boolean)
    .join('\n')
}

function artifactParts(artifact) {
  return (Array.isArray(artifact?.parts) ? artifact.parts : [])
    .slice(0, MAX_ARTIFACT_PARTS)
    .map(partContent)
    .filter(Boolean)
}

function projectArtifact(artifact, index) {
  const parts = artifactParts(artifact)
  if (!parts.length) return null
  return {
    artifactId: bounded(artifact?.artifactId, 160) || `a2a_artifact_${index + 1}`,
    ...(bounded(artifact?.name, 240) ? { name: bounded(artifact.name, 240) } : {}),
    ...(bounded(artifact?.description, 1_000)
      ? { description: bounded(artifact.description, 1_000) }
      : {}),
    parts,
  }
}

function messageArtifact(message) {
  const parts = (Array.isArray(message?.parts) ? message.parts : [])
    .map(partContent)
    .filter(part => part && part.text === undefined)
  if (!parts.length) return []
  return [{
    artifactId: 'a2a_message',
    name: 'A2A response',
    parts,
  }]
}

function taskArtifacts(task) {
  return (Array.isArray(task?.artifacts) ? task.artifacts : [])
    .slice(0, MAX_ARTIFACTS)
    .map(projectArtifact)
    .filter(Boolean)
}

function agentHistoryText(task) {
  return (Array.isArray(task?.history) ? task.history : [])
    .filter(message => (
      message?.role === Role.ROLE_AGENT
      || String(message?.role).toUpperCase() === 'ROLE_AGENT'
    ))
    .map(messageText)
    .filter(Boolean)
}

function uniqueLines(values) {
  const used = new Set()
  return values.filter(value => {
    const text = clean(value)
    if (!text || used.has(text)) return false
    used.add(text)
    return true
  })
}

function taskSummary(task) {
  const status = messageText(task?.status?.message)
  const history = agentHistoryText(task)
  const artifactText = taskArtifacts(task)
    .flatMap(artifact => artifact.parts)
    .map(part => clean(part.text))
    .filter(Boolean)
  const lines = uniqueLines([status, ...history, ...artifactText])
  return {
    content: bounded(lines.join('\n\n'), MAX_TEXT_CHARS),
    fallback: status || history.at(-1) || '',
  }
}

function taskState(task) {
  return task?.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED
}

function publicState(state) {
  switch (state) {
    case TaskState.TASK_STATE_SUBMITTED:
      return 'submitted'
    case TaskState.TASK_STATE_WORKING:
    case TaskState.TASK_STATE_UNSPECIFIED:
      return 'working'
    case TaskState.TASK_STATE_COMPLETED:
      return 'completed'
    case TaskState.TASK_STATE_FAILED:
    case TaskState.TASK_STATE_REJECTED:
      return 'failed'
    case TaskState.TASK_STATE_CANCELED:
      return 'cancelled'
    case TaskState.TASK_STATE_INPUT_REQUIRED:
      return 'input_required'
    case TaskState.TASK_STATE_AUTH_REQUIRED:
      return 'auth_required'
    default:
      return 'working'
  }
}

function taskLike(value) {
  return Boolean(value && typeof value === 'object' && value.status && clean(value.id))
}

function messageLike(value) {
  return Boolean(value && typeof value === 'object' && Array.isArray(value.parts))
}

function streamValue(value) {
  const payload = value?.payload
  return payload && typeof payload === 'object' && payload.value
    ? payload.value
    : value
}

function statusUpdateLike(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && (
      value.kind === 'status-update'
      || value.sessionUpdate === 'statusUpdate'
      || (value.status && clean(value.taskId) && !Array.isArray(value.artifacts))
    ),
  )
}

function artifactUpdateLike(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && value.artifact
    && (value.kind === 'artifact-update' || clean(value.taskId)),
  )
}

function outgoingText(work) {
  const objective = backendInstructionFromWork(work)
  const supplied = (Array.isArray(work?.inputParts) ? work.inputParts : [])
    .filter(part => part?.type === 'text')
    .map(part => clean(part.text))
    .filter(text => text && text !== objective)
  return uniqueLines([objective, ...supplied]).join('\n\n')
}

function outgoingPart(part) {
  if (part?.type !== 'file') return null
  const mediaType = clean(part.mime || part.mimeType) || 'application/octet-stream'
  const filename = clean(part.filename)
  const parsed = parseDataUrl(part.url)
  if (parsed) {
    return {
      content: { $case: 'raw', value: Buffer.from(parsed.data, 'base64') },
      metadata: undefined,
      filename,
      mediaType,
    }
  }
  const url = clean(part.url)
  if (!url) return null
  return {
    content: { $case: 'url', value: url },
    metadata: undefined,
    filename,
    mediaType,
  }
}

function outgoingMessage(work) {
  const text = outgoingText(work)
  const parts = [{
    content: { $case: 'text', value: text },
    metadata: undefined,
    filename: '',
    mediaType: 'text/plain',
  }]
  parts.push(
    ...(Array.isArray(work?.inputParts) ? work.inputParts : [])
      .map(outgoingPart)
      .filter(Boolean),
  )
  return {
    messageId: randomUUID(),
    contextId: '',
    taskId: '',
    role: Role.ROLE_USER,
    parts,
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  }
}

function continuationMessage(text, task) {
  return {
    messageId: randomUUID(),
    contextId: clean(task?.contextId),
    taskId: clean(task?.id),
    role: Role.ROLE_USER,
    parts: [{
      content: { $case: 'text', value: clean(text) },
      metadata: undefined,
      filename: '',
      mediaType: 'text/plain',
    }],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  }
}

function deferred() {
  let resolvePromise
  const promise = new Promise(resolve => { resolvePromise = resolve })
  return { promise, resolve: resolvePromise }
}

function waitForDeferred(promise, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal?.removeEventListener('abort', abort)
      reject(signal.reason)
    }
    signal?.addEventListener('abort', abort, { once: true })
    promise.then(value => {
      signal?.removeEventListener('abort', abort)
      resolve(value)
    }, error => {
      signal?.removeEventListener('abort', abort)
      reject(error)
    })
  })
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const done = () => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }
    const timer = setTimeout(done, ms)
    const abort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(signal.reason)
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

function deadline(ms) {
  if (!(ms > 0)) return null
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new DOMException('The operation timed out', 'TimeoutError'))
  }, ms)
  return {
    signal: controller.signal,
    dispose: () => clearTimeout(timer),
  }
}

export class A2ABackendError extends Error {
  constructor(message, { code = 'A2A_BACKEND_ERROR', cause } = {}) {
    super(message, { cause })
    this.name = 'A2ABackendError'
    this.code = code
  }
}

/**
 * Optional A2A client adapter for one remote Backend Action Agent.
 *
 * A2A discovery, transport selection, Tasks, Messages and Artifacts stay in
 * this adapter. The Gateway observes only the protocol-neutral BackendPort.
 */
export class A2ABackendAdapter {
  constructor({
    agentCard,
    agentCardUrl = '',
    headers = {},
    token = '',
    fetchImpl,
    clientFactory = createOfficialClient,
    acceptedOutputModes = DEFAULT_OUTPUT_MODES,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    legacyCompat = true,
    label = 'A2A Agent',
  } = {}) {
    if (!agentCard && !clean(agentCardUrl)) {
      throw new TypeError('A2A adapter requires agentCard or agentCardUrl')
    }
    this.configuredCard = agentCard || null
    this.agentCardUrl = safeUrl(agentCardUrl, 'agentCardUrl')
    this.clientFactory = clientFactory
    this.acceptedOutputModes = [...acceptedOutputModes]
    this.pollIntervalMs = positiveNumber(
      pollIntervalMs,
      DEFAULT_POLL_INTERVAL_MS,
      10,
    )
    this.timeoutMs = nonNegativeNumber(timeoutMs, DEFAULT_TIMEOUT_MS)
    this.requestTimeoutMs = positiveNumber(
      requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      100,
    )
    this.fetchImpl = authenticatedFetch({
      fetchImpl,
      headers,
      token,
      requestTimeoutMs: this.requestTimeoutMs,
    })
    this.legacyCompat = legacyCompat !== false
    this.label = clean(agentCard?.name || label) || 'A2A Agent'
    this.client = null
    this.agentCard = null
    this.startPromise = null
    this.ready = false
    this.closed = false
    this.failure = null
    this.active = new Map()
    this.listeners = new Set()
  }

  describe() {
    const card = this.agentCard || this.configuredCard
    const selected = this.client?.transport
    return {
      configured: true,
      enabled: true,
      protocol: 'a2a',
      label: clean(card?.name || this.label) || 'A2A Agent',
      transport: clean(selected?.protocolName) || 'a2a',
      protocolVersion: clean(this.client?.protocolVersion) || null,
      agentVersion: clean(card?.version) || null,
      capabilities: {
        cancel: true,
        authorization: false,
        inputRequests: 'task-state',
        taskUpdates: 'native',
        discovery: true,
        streaming: card?.capabilities?.streaming === true,
        inputModes: Array.isArray(card?.defaultInputModes)
          ? [...card.defaultInputModes]
          : [],
        outputModes: Array.isArray(card?.defaultOutputModes)
          ? [...card.defaultOutputModes]
          : [],
      },
    }
  }

  async start() {
    if (this.closed) throw new A2ABackendError('A2A adapter is closed')
    if (this.ready) return this.health()
    if (this.startPromise) return this.startPromise
    this.startPromise = (async () => {
      try {
        const connected = await this.clientFactory({
          agentCard: this.configuredCard,
          agentCardUrl: this.agentCardUrl,
          fetchImpl: this.fetchImpl,
          legacyCompat: this.legacyCompat,
          acceptedOutputModes: this.acceptedOutputModes,
        })
        this.client = connected?.client || connected
        if (!this.client || typeof this.client.sendMessage !== 'function') {
          throw new TypeError('A2A client factory returned an invalid client')
        }
        this.agentCard = connected?.agentCard || this.configuredCard || null
        this.ready = true
        this.failure = null
        return {
          ok: true,
          status: 'ready',
          ...this.describe(),
        }
      } catch (error) {
        this.ready = false
        this.failure = error
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
      } catch (error) {
        return {
          ok: false,
          status: 'failed',
          code: clean(error?.code) || 'A2A_CONNECTION_FAILED',
          error: asErrorMessage(error),
          protocol: 'a2a',
        }
      }
    }
    return {
      ok: this.ready && !this.closed,
      status: this.ready && !this.closed ? 'ready' : 'stopped',
      protocol: 'a2a',
      ...(this.failure ? { error: asErrorMessage(this.failure) } : {}),
    }
  }

  publish(event, record) {
    try {
      record?.onEvent?.(event)
    } catch {
      // Per-submission observers cannot interrupt backend execution.
    }
    const published = {
      ...event,
      taskId: record?.gatewayTaskId || null,
      ownerId: record?.ownerId || null,
    }
    for (const listener of this.listeners) {
      try {
        listener(published)
      } catch {
        // Subscribers are isolated from the adapter and from each other.
      }
    }
  }

  update(record, task) {
    record.task = task
    record.remoteTaskId = clean(task?.id) || record.remoteTaskId
    const state = publicState(taskState(task))
    const message = bounded(messageText(task?.status?.message), 1_000)
    const digest = `${state}\u0000${message}`
    if (digest !== record.lastDigest) {
      record.lastDigest = digest
      record.activity = [{
        id: 'backend-status',
        kind: 'status',
        status: state,
        ...(message ? { message } : {}),
      }]
      this.publish(backendEvent(BackendEventType.ACTIVITY, {
        activity: record.activity[0],
      }), record)
      if (message) {
        this.publish(backendEvent(BackendEventType.MESSAGE, { message }), record)
      }
    }
    for (const artifact of taskArtifacts(task)) {
      const artifactDigest = JSON.stringify(artifact)
      if (record.artifactDigests.get(artifact.artifactId) === artifactDigest) {
        continue
      }
      record.artifactDigests.set(artifact.artifactId, artifactDigest)
      this.publish(backendEvent(BackendEventType.ARTIFACT, { artifact }), record)
    }
  }

  outcomeFromMessage(message) {
    const content = bounded(messageText(message)) || '后台工作已经完成。'
    return {
      content,
      artifacts: messageArtifact(message),
    }
  }

  outcomeFromTask(task) {
    const summary = taskSummary(task)
    const content = summary.content
      || bounded(summary.fallback)
      || '后台工作已经完成。'
    return {
      content,
      artifacts: taskArtifacts(task),
    }
  }

  taskError(task) {
    const state = taskState(task)
    const detail = bounded(messageText(task?.status?.message), 1_000)
    if (state === TaskState.TASK_STATE_CANCELED) {
      return cancellationError(clean(task?.id), detail)
    }
    if (INTERRUPTED_STATES.has(state)) {
      return new A2ABackendError(
        detail || `A2A task requires unsupported interaction (${publicState(state)})`,
        { code: 'A2A_INTERACTION_REQUIRED' },
      )
    }
    return new A2ABackendError(
      detail || `A2A task ended with state ${publicState(state)}`,
      { code: state === TaskState.TASK_STATE_REJECTED ? 'A2A_TASK_REJECTED' : 'A2A_TASK_FAILED' },
    )
  }

  async continueInterruptedTask(record, task, signal) {
    const state = taskState(task)
    const kind = state === TaskState.TASK_STATE_AUTH_REQUIRED
      ? 'authorization'
      : 'input'
    const prompt = bounded(messageText(task?.status?.message), 4_000)
      || (kind === 'authorization'
        ? '后台工作需要完成认证后才能继续。'
        : '后台工作需要你补充信息后才能继续。')
    const current = record.pendingInput
    const request = current?.input || normalizeInputRequest({
      id: `input_${randomUUID().replaceAll('-', '')}`,
      taskId: record.gatewayTaskId,
      status: InputRequestStatus.PENDING,
      kind,
      mode: 'text',
      prompt,
    })
    if (!current) {
      const pending = deferred()
      record.pendingInput = { input: request, pending, settled: false }
      this.publish(backendEvent(BackendEventType.INPUT_REQUESTED, {
        input: request,
      }), record)
    }
    const answer = await waitForDeferred(
      record.pendingInput.pending.promise,
      signal,
    )
    const resolved = resolveInputRequest(request, answer.action === 'accept'
      ? InputRequestStatus.ACCEPTED
      : answer.action === 'decline'
        ? InputRequestStatus.DECLINED
        : InputRequestStatus.CANCELLED)
    record.pendingInput = null
    this.publish(backendEvent(BackendEventType.INPUT_RESOLVED, {
      input: resolved,
    }), record)
    if (answer.action === 'cancel') {
      await this.bestEffortCancel(record)
      throw cancellationError(record.gatewayTaskId)
    }
    const text = answer.action === 'decline'
      ? clean(answer.text) || '用户拒绝提供所请求的信息。'
      : clean(answer.text)
        || (answer.values && Object.keys(answer.values).length
          ? JSON.stringify(answer.values)
          : '用户已确认，请继续处理。')
    const result = await record.client.sendMessage({
      message: continuationMessage(text, task),
      configuration: {
        acceptedOutputModes: this.acceptedOutputModes,
        historyLength: 20,
        returnImmediately: true,
      },
      metadata: undefined,
    }, { signal })
    if (taskLike(result)) return result
    if (messageLike(result)) return { __outcome: this.outcomeFromMessage(result) }
    throw new A2ABackendError('A2A agent returned an invalid continuation response', {
      code: 'A2A_INVALID_RESPONSE',
    })
  }

  async bestEffortCancel(record) {
    if (!record?.remoteTaskId || !record.client?.cancelTask) return
    try {
      await record.client.cancelTask({ id: record.remoteTaskId }, {
        signal: AbortSignal.timeout(Math.min(this.requestTimeoutMs, 10_000)),
      })
    } catch {
      // The primary operation error is more useful than cleanup failure.
    }
  }

  async awaitTask(record, initial, signal) {
    let task = initial
    this.update(record, task)
    while (!TERMINAL_STATES.has(taskState(task))) {
      if (INTERRUPTED_STATES.has(taskState(task))) {
        task = await this.continueInterruptedTask(record, task, signal)
        if (task?.__outcome) return task.__outcome
        this.update(record, task)
        continue
      }
      await wait(this.pollIntervalMs, signal)
      task = await record.client.getTask({
        id: record.remoteTaskId,
        historyLength: 20,
      }, { signal })
      this.update(record, task)
    }
    if (taskState(task) !== TaskState.TASK_STATE_COMPLETED) {
      throw this.taskError(task)
    }
    return this.outcomeFromTask(task)
  }

  async consumeStream(record, stream, signal) {
    let task = null
    let message = null
    for await (const rawEvent of stream) {
      if (signal?.aborted) throw signal.reason
      const event = streamValue(rawEvent)
      if (taskLike(event)) {
        task = event
        this.update(record, task)
        if (INTERRUPTED_STATES.has(taskState(task))) {
          task = await this.continueInterruptedTask(record, task, signal)
          if (task?.__outcome) return task.__outcome
          this.update(record, task)
        }
        continue
      }
      if (messageLike(event)) {
        message = event
        const text = bounded(messageText(event), 1_000)
        if (text) {
          this.publish(backendEvent(BackendEventType.MESSAGE, {
            message: text,
          }), record)
        }
        continue
      }
      if (statusUpdateLike(event)) {
        task = {
          ...(task || record.task || {}),
          id: clean(event.taskId) || record.remoteTaskId,
          status: event.status,
        }
        this.update(record, task)
        if (INTERRUPTED_STATES.has(taskState(task))) {
          task = await this.continueInterruptedTask(record, task, signal)
          if (task?.__outcome) return task.__outcome
          this.update(record, task)
        }
        continue
      }
      if (artifactUpdateLike(event)) {
        const artifact = projectArtifact(event.artifact, 0)
        if (!artifact) continue
        task ||= record.task || {
          id: clean(event.taskId) || record.remoteTaskId,
          status: { state: TaskState.TASK_STATE_WORKING },
          artifacts: [],
        }
        const previous = Array.isArray(task.artifacts) ? task.artifacts : []
        const sourceId = clean(event.artifact?.artifactId)
        const existing = previous.find(
          item => clean(item?.artifactId) === sourceId,
        )
        const nextArtifact = event.append && existing
          ? {
              ...existing,
              ...event.artifact,
              parts: [
                ...(Array.isArray(existing.parts) ? existing.parts : []),
                ...(Array.isArray(event.artifact.parts)
                  ? event.artifact.parts
                  : []),
              ],
            }
          : event.artifact
        task.artifacts = [
          ...previous.filter(item => clean(item?.artifactId) !== sourceId),
          nextArtifact,
        ]
        const projected = projectArtifact(nextArtifact, 0)
        if (!projected) continue
        const digest = JSON.stringify(projected)
        if (record.artifactDigests.get(projected.artifactId) !== digest) {
          record.artifactDigests.set(projected.artifactId, digest)
          this.publish(backendEvent(BackendEventType.ARTIFACT, {
            artifact: projected,
          }), record)
        }
      }
    }
    if (task) {
      if (!TERMINAL_STATES.has(taskState(task))) {
        return this.awaitTask(record, task, signal)
      }
      if (taskState(task) !== TaskState.TASK_STATE_COMPLETED) {
        throw this.taskError(task)
      }
      return this.outcomeFromTask(task)
    }
    if (message) return this.outcomeFromMessage(message)
    throw new A2ABackendError('A2A agent returned an empty stream', {
      code: 'A2A_INVALID_RESPONSE',
    })
  }

  async submit(work, { signal, onEvent } = {}) {
    const taskId = clean(work?.id)
    const ownerId = clean(work?.ownerId)
    const input = outgoingText(work)
    if (!taskId || !ownerId || !input) {
      throw new A2ABackendError(
        'Backend submit requires task id, owner and input',
        { code: 'INVALID_WORK' },
      )
    }
    if (this.active.has(taskId)) {
      throw new A2ABackendError(`Task ${taskId} is already active`, {
        code: 'WORK_ALREADY_ACTIVE',
      })
    }
    await this.start()
    const controller = new AbortController()
    const timeout = deadline(this.timeoutMs)
    const workSignal = AbortSignal.any([
      signal,
      controller.signal,
      timeout?.signal,
    ].filter(Boolean))
    const record = {
      gatewayTaskId: taskId,
      ownerId,
      client: this.client,
      controller,
      onEvent,
      remoteTaskId: '',
      task: null,
      activity: [],
      lastDigest: '',
      artifactDigests: new Map(),
      pendingInput: null,
    }
    this.active.set(taskId, record)
    try {
      const request = {
        message: outgoingMessage(work),
        configuration: {
          acceptedOutputModes: this.acceptedOutputModes,
          historyLength: 20,
          returnImmediately: true,
        },
        metadata: undefined,
      }
      if (
        this.agentCard?.capabilities?.streaming === true
        && typeof record.client.sendMessageStream === 'function'
      ) {
        request.configuration.returnImmediately = false
        return await this.consumeStream(
          record,
          record.client.sendMessageStream(request, { signal: workSignal }),
          workSignal,
        )
      }
      const result = await record.client.sendMessage(
        request,
        { signal: workSignal },
      )
      if (taskLike(result)) {
        record.remoteTaskId = clean(result.id)
        return await this.awaitTask(record, result, workSignal)
      }
      if (messageLike(result)) return this.outcomeFromMessage(result)
      throw new A2ABackendError('A2A agent returned an invalid response', {
        code: 'A2A_INVALID_RESPONSE',
      })
    } catch (error) {
      if (controller.signal.aborted || signal?.aborted) {
        throw cancellationError(taskId, error)
      }
      if (timeout?.signal.aborted) {
        await this.bestEffortCancel(record)
        throw new A2ABackendError(`A2A task timed out after ${this.timeoutMs} ms`, {
          code: 'A2A_TIMEOUT',
          cause: error,
        })
      }
      throw error
    } finally {
      timeout?.dispose()
      if (this.active.get(taskId) === record) this.active.delete(taskId)
    }
  }

  status(taskId, { ownerId } = {}) {
    const id = clean(taskId)
    if (!id) {
      return {
        ok: this.ready && !this.closed,
        status: this.ready && !this.closed ? 'ready' : 'stopped',
        protocol: 'a2a',
      }
    }
    const record = this.active.get(id)
    if (!record || (ownerId && clean(ownerId) !== record.ownerId)) {
      return { taskId: id, state: 'not_found', activity: [] }
    }
    return {
      taskId: id,
      state: record.task ? publicState(taskState(record.task)) : 'working',
      activity: [...record.activity],
    }
  }

  async cancel(taskId, { ownerId } = {}) {
    const id = clean(taskId)
    const record = this.active.get(id)
    if (!record) return { taskId: id, state: 'not_found' }
    if (ownerId && clean(ownerId) !== record.ownerId) {
      throw new A2ABackendError('Cannot cancel task owned by another user', {
        code: 'WORK_NOT_FOUND',
      })
    }
    let state = 'cancelled'
    if (record.remoteTaskId) {
      const task = await record.client.cancelTask({ id: record.remoteTaskId }, {
        signal: AbortSignal.timeout(Math.min(this.requestTimeoutMs, 10_000)),
      })
      if (taskLike(task)) {
        this.update(record, task)
        state = publicState(taskState(task))
      }
    }
    if (state === 'cancelled') {
      record.controller.abort(cancellationError(id))
    }
    return { taskId: id, state }
  }

  async respondAuthorization() {
    throw new A2ABackendError(
      'A2A adapter does not define an authorization decision extension',
      { code: 'A2A_AUTHORIZATION_UNSUPPORTED' },
    )
  }

  async respondInput(taskId, inputRequestId, response = {}, { ownerId } = {}) {
    const id = clean(taskId)
    const record = this.active.get(id)
    if (!record || (ownerId && clean(ownerId) !== record.ownerId)) {
      throw new A2ABackendError('Input request does not belong to an active task', {
        code: 'WORK_NOT_FOUND',
      })
    }
    if (record.pendingInput?.input?.id !== clean(inputRequestId)) {
      throw new A2ABackendError('Input request is no longer pending', {
        code: 'INPUT_NOT_PENDING',
      })
    }
    if (record.pendingInput.settled) {
      throw new A2ABackendError('Input response was already submitted', {
        code: 'INPUT_ALREADY_SUBMITTED',
      })
    }
    const action = ['accept', 'decline', 'cancel'].includes(response.action)
      ? response.action
      : 'accept'
    record.pendingInput.settled = true
    record.pendingInput.pending.resolve({
      action,
      text: clean(response.text),
      values: response.values,
    })
    return resolveInputRequest(
      record.pendingInput.input,
      action === 'accept'
        ? InputRequestStatus.ACCEPTED
        : action === 'decline'
          ? InputRequestStatus.DECLINED
          : InputRequestStatus.CANCELLED,
    )
  }

  subscribe(listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('Backend event listener must be a function')
    }
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async close() {
    if (this.closed) return
    this.closed = true
    const active = [...this.active.values()]
    await Promise.allSettled(active.map(record => this.bestEffortCancel(record)))
    for (const record of active) {
      record.controller.abort(cancellationError(record.gatewayTaskId))
    }
    this.active.clear()
    this.listeners.clear()
    this.ready = false
    this.client = null
  }
}

export function createA2ABackendAdapter(options) {
  return defineBackendAdapter(new A2ABackendAdapter(options), {
    name: 'A2A backend adapter',
  })
}

export const A2A_BACKEND_ADAPTER_VERSION = '1.0.0'
export { Role as A2ARole, TaskState as A2ATaskState }
