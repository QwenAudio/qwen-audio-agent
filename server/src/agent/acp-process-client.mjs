import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { stripVTControlCharacters } from 'node:util'
import * as acp from '@agentclientprotocol/sdk'
import { PACKAGE_VERSION } from '../core/package-version.mjs'
import { AgentError, requestSignal } from './backend-adapter.mjs'
import { logger } from '../core/logger.mjs'

const MAX_STDERR_CHARS = 12_000

function clean(value) {
  return String(value || '').trim()
}

function cleanProcessOutput(value, sanitizeProcessOutput) {
  const stripped = stripVTControlCharacters(String(value || '')).trim()
  return clean(sanitizeProcessOutput?.(stripped) ?? stripped)
}

function requestErrorDetails(error) {
  const details = error?.data?.details
  if (typeof details === 'string' && details.trim()) return details.trim()
  if (typeof error?.data === 'string' && error.data.trim()) {
    return error.data.trim()
  }
  return ''
}

function requestErrorMessage(error, formatRequestError) {
  const message = clean(error?.message || error)
  const details = requestErrorDetails(error)
  const formatted = clean(formatRequestError?.({ error, message, details }))
  if (formatted) return formatted
  return details && !message.includes(details)
    ? `${message}（${details}）`
    : message
}

function textFromUpdate(update) {
  if (
    update?.sessionUpdate !== 'agent_message_chunk'
    || update.content?.type !== 'text'
  ) return ''
  return String(update.content.text || '')
}

function processError(label, message, stderr = '') {
  return new AgentError(
    `${label} ACP ${message}${stderr ? `：${stderr}` : ''}`,
    { protocol: 'acp' },
  )
}

export class AcpProcessClient {
  constructor({
    label,
    command,
    args = [],
    cwd,
    env = process.env,
    timeoutMs = 300_000,
    spawnImpl = spawn,
    onPermission,
    onUpdate,
    sanitizeProcessOutput,
    formatRequestError,
  }) {
    this.label = label
    this.command = command
    this.args = args
    this.cwd = cwd
    this.env = env
    this.timeoutMs = timeoutMs
    this.spawn = spawnImpl
    this.onPermission = onPermission
    this.onUpdate = onUpdate
    this.sanitizeProcessOutput = sanitizeProcessOutput
    this.formatRequestError = formatRequestError
    this.child = null
    this.connection = null
    this.context = null
    this.initializeResult = null
    this.startPromise = null
    this.stderr = ''
    this.activePrompts = new Map()
    this.sessions = new Map()
  }

  get capabilities() {
    return this.initializeResult?.agentCapabilities || {}
  }

  get agentInfo() {
    return this.initializeResult?.agentInfo || null
  }

  appendStderr(chunk) {
    this.stderr = cleanProcessOutput(
      `${this.stderr}${String(chunk || '')}`,
      this.sanitizeProcessOutput,
    ).slice(-MAX_STDERR_CHARS)
  }

  async start() {
    if (this.startPromise) return this.startPromise
    if (
      this.initializeResult
      && this.context
      && this.child?.exitCode == null
    ) {
      return this.initializeResult
    }
    this.startPromise = this.startProcess()
      .finally(() => {
        this.startPromise = null
      })
    return this.startPromise
  }

  async startProcess() {
    this.stderr = ''
    const child = this.spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const processLogger = logger.child({ subsystem: 'acp', backend: this.label })
    processLogger.info('acp.process_started', {
      pid: child.pid,
      command: this.command,
    })
    this.child = child
    child.stderr?.on('data', chunk => this.appendStderr(chunk))
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin),
      Readable.toWeb(child.stdout),
    )
    const app = acp.client({ name: 'qwen-audio-agent' })
      .onRequest(
        acp.methods.client.session.requestPermission,
        context => this.handlePermission(context.params, context.signal),
      )
      .onNotification(
        acp.methods.client.session.update,
        context => this.handleUpdate(context.params),
      )
    const connection = app.connect(stream)
    this.connection = connection
    this.context = connection.agent
    const exited = new Promise((_, reject) => {
      child.once('error', error => {
        processLogger.error('acp.process_start_failed', { error })
        reject(processError(
          this.label,
          `进程启动失败（${error.message}）`,
        ))
      })
      child.once('exit', (code, signal) => {
        processLogger.warn('acp.process_exited', { code, signal })
        reject(processError(
          this.label,
          `进程意外退出（${signal || code || 'unknown'}）`,
          clean(this.stderr),
        ))
      })
    })
    // Promise.race stops observing the loser after initialization succeeds.
    // Keep the process lifecycle rejection handled for the rest of the client.
    exited.catch(() => {})
    try {
      this.initializeResult = await Promise.race([
        this.context.request(
          acp.methods.agent.initialize,
          {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {},
            clientInfo: {
              name: 'qwen-audio-agent',
              title: 'qwen-audio-agent Gateway',
              version: PACKAGE_VERSION,
            },
          },
          { signal: AbortSignal.timeout(15_000) },
        ),
        exited,
      ])
      processLogger.info('acp.initialized', {
        protocolVersion: this.initializeResult?.protocolVersion,
        agentName: this.initializeResult?.agentInfo?.name,
        agentVersion: this.initializeResult?.agentInfo?.version,
      })
      if (
        this.initializeResult?.protocolVersion !== acp.PROTOCOL_VERSION
      ) {
        throw processError(
          this.label,
          `协议版本不兼容（Agent=${
            this.initializeResult?.protocolVersion
          }，Client=${acp.PROTOCOL_VERSION}）`,
        )
      }
      connection.closed.finally(() => {
        if (this.connection !== connection) return
        this.connection = null
        this.context = null
        this.initializeResult = null
      }).catch(() => {})
      return this.initializeResult
    } catch (error) {
      processLogger.error('acp.initialization_failed', { error })
      connection.close(error)
      if (child.exitCode == null) child.kill('SIGTERM')
      this.connection = null
      this.context = null
      this.initializeResult = null
      throw error
    }
  }

  async handlePermission(params, signal) {
    if (!this.onPermission) {
      return { outcome: { outcome: 'cancelled' } }
    }
    const active = this.activePrompts.get(String(params.sessionId))
    active?.pauseTimeout?.()
    try {
      return await this.onPermission(params, {
        signal,
        session: this.sessions.get(String(params.sessionId)),
      })
    } finally {
      active?.resumeTimeout?.()
    }
  }

  handleUpdate(notification) {
    const sessionId = String(notification?.sessionId || '')
    const update = notification?.update
    if (!sessionId || !update) return
    const active = this.activePrompts.get(sessionId)
    const text = textFromUpdate(update)
    if (active && text) active.text.push(text)
    try {
      active?.onUpdate?.(update, notification)
      this.onUpdate?.(update, {
        notification,
        session: this.sessions.get(sessionId),
      })
    } catch {
      // UI projection must never interrupt the ACP connection.
    }
  }

  requestSignal(signal, timeoutMs = this.timeoutMs) {
    return requestSignal(signal, timeoutMs)
  }

  async request(method, params, {
    signal,
    timeoutMs = this.timeoutMs,
  } = {}) {
    try {
      await this.start()
      return await this.context.request(method, params, {
        signal: this.requestSignal(signal, timeoutMs),
      })
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      const isRequestError = error?.name === 'RequestError'
      const stderr = isRequestError
        ? ''
        : cleanProcessOutput(this.stderr, this.sanitizeProcessOutput)
      throw new AgentError(
        `${this.label} ACP ${method} 失败：${
          requestErrorMessage(error, this.formatRequestError)
        }${
          stderr ? `：${stderr}` : ''
        }`,
        {
          body: stderr || requestErrorDetails(error),
          protocol: 'acp',
        },
      )
    }
  }

  async notify(method, params) {
    await this.start()
    return this.context.notify(method, params)
  }

  rememberSession(sessionId, details = {}) {
    const id = String(sessionId || '')
    if (!id) return null
    const session = {
      ...(this.sessions.get(id) || {}),
      ...details,
      sessionId: id,
    }
    this.sessions.set(id, session)
    return session
  }

  async newSession({
    cwd = this.cwd,
    mcpServers = [],
    meta,
    ownerId,
    role = 'project',
  } = {}) {
    const response = await this.request(acp.methods.agent.session.new, {
      cwd,
      mcpServers,
      ...(meta ? { _meta: meta } : {}),
    })
    return this.rememberSession(response.sessionId, {
      cwd,
      meta,
      ownerId,
      role,
      mcpServers,
      response,
    })
  }

  async resumeSession(sessionId, {
    cwd = this.cwd,
    mcpServers = [],
    meta,
    ownerId,
    role = 'project',
  } = {}) {
    await this.start()
    const params = {
      sessionId: String(sessionId),
      cwd,
      mcpServers,
      ...(meta ? { _meta: meta } : {}),
    }
    const sessionCapabilities = this.capabilities.sessionCapabilities || {}
    let response
    if (sessionCapabilities.resume) {
      response = await this.request(acp.methods.agent.session.resume, params)
    } else if (this.capabilities.loadSession) {
      response = await this.request(acp.methods.agent.session.load, params)
    } else {
      throw new AgentError(
        `${this.label} ACP 不支持继续已有 Session`,
        { protocol: 'acp' },
      )
    }
    return this.rememberSession(sessionId, {
      cwd,
      meta,
      ownerId,
      role,
      mcpServers,
      response,
    })
  }

  async listSessions({ cwd, limit = 100, signal } = {}) {
    await this.start()
    if (!this.capabilities.sessionCapabilities?.list) return []
    const sessions = []
    let cursor = null
    do {
      const response = await this.request(
        acp.methods.agent.session.list,
        {
          ...(cwd ? { cwd } : {}),
          ...(cursor ? { cursor } : {}),
          _meta: { limit: Math.min(100, Math.max(1, limit - sessions.length)) },
        },
        { signal, timeoutMs: 15_000 },
      )
      sessions.push(...(response.sessions || []))
      cursor = response.nextCursor || null
    } while (cursor && sessions.length < limit)
    return sessions.slice(0, limit)
  }

  async prompt(sessionId, prompt, {
    signal,
    timeoutMs = this.timeoutMs,
    onUpdate,
  } = {}) {
    const id = String(sessionId)
    if (this.activePrompts.has(id)) {
      throw new AgentError(
        `${this.label} Session ${id} 已有正在执行的请求`,
        { status: 409, protocol: 'acp' },
      )
    }
    const timeoutController = new AbortController()
    let timeoutTimer = null
    let permissionDepth = 0
    const armTimeout = () => {
      clearTimeout(timeoutTimer)
      timeoutTimer = null
      if (!timeoutMs || timeoutController.signal.aborted) return
      timeoutTimer = setTimeout(() => {
        timeoutController.abort(new DOMException(
          'The operation was aborted due to timeout',
          'TimeoutError',
        ))
      }, timeoutMs)
      timeoutTimer.unref?.()
    }
    const active = {
      text: [],
      onUpdate,
      pauseTimeout: () => {
        permissionDepth += 1
        clearTimeout(timeoutTimer)
        timeoutTimer = null
      },
      resumeTimeout: () => {
        permissionDepth = Math.max(0, permissionDepth - 1)
        if (!permissionDepth) armTimeout()
      },
    }
    this.activePrompts.set(id, active)
    const combined = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal
    armTimeout()
    const cancel = () => {
      this.notify(acp.methods.agent.session.cancel, {
        sessionId: id,
      }).catch(() => {})
    }
    combined?.addEventListener('abort', cancel, { once: true })
    if (combined?.aborted) cancel()
    try {
      const response = await this.request(
        acp.methods.agent.session.prompt,
        {
          sessionId: id,
          prompt: [{ type: 'text', text: String(prompt || '') }],
        },
        { signal: combined, timeoutMs: 0 },
      )
      const content = active.text.join('').trim()
      if (response?.stopReason === 'cancelled') {
        throw combined?.reason || new Error('ACP Session 已取消')
      }
      return { content, response }
    } finally {
      clearTimeout(timeoutTimer)
      combined?.removeEventListener('abort', cancel)
      if (this.activePrompts.get(id) === active) {
        this.activePrompts.delete(id)
      }
    }
  }

  async cancelSession(sessionId) {
    await this.notify(acp.methods.agent.session.cancel, {
      sessionId: String(sessionId),
    })
  }

  async setSessionConfigOption(sessionId, configId, value) {
    return this.request(
      acp.methods.agent.session.setConfigOption,
      {
        sessionId: String(sessionId),
        configId: String(configId),
        value: String(value),
      },
      { timeoutMs: 15_000 },
    )
  }

  async setLegacySessionModel(sessionId, modelId) {
    return this.request(
      'session/set_model',
      {
        sessionId: String(sessionId),
        modelId: String(modelId),
      },
      { timeoutMs: 15_000 },
    )
  }

  async closeSession(sessionId) {
    await this.start()
    if (!this.capabilities.sessionCapabilities?.close) {
      await this.cancelSession(sessionId)
      return
    }
    await this.request(
      acp.methods.agent.session.close,
      { sessionId: String(sessionId) },
      { timeoutMs: 5000 },
    )
    this.sessions.delete(String(sessionId))
  }

  async close() {
    for (const sessionId of this.activePrompts.keys()) {
      this.cancelSession(sessionId).catch(() => {})
    }
    const connection = this.connection
    const child = this.child
    this.connection = null
    this.context = null
    this.initializeResult = null
    connection?.close()
    if (child && child.exitCode == null) child.kill('SIGTERM')
    this.child = null
  }
}
