import { spawn } from 'node:child_process'
import { extname } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { stripVTControlCharacters } from 'node:util'
import * as acp from '@agentclientprotocol/sdk'
import { PACKAGE_VERSION } from '../core/package-version.mjs'
import { AgentError, requestSignal } from './backend-adapter.mjs'
import { logger } from '../core/logger.mjs'
import {
  assertPromptCapabilities,
  normalizeAcpPrompt,
} from './acp-content.mjs'
import { assertMcpServerCapabilities } from './acp-capabilities.mjs'
import { applySessionMetadataUpdate } from './acp-backend-session-utils.mjs'

const MAX_STDERR_CHARS = 12_000
// Gateway has a 2s hard shutdown deadline. Leave enough time for adapter and
// logger cleanup after escalating an unresponsive process tree.
const PROCESS_TREE_GRACE_MS = 750
const PROCESS_TREE_POLL_MS = 25

function clean(value) {
  return String(value || '').trim()
}

function cleanProcessOutput(value, sanitizeProcessOutput) {
  const stripped = stripVTControlCharacters(String(value || '')).trim()
  return clean(sanitizeProcessOutput?.(stripped) ?? stripped)
}

function requestProcessOutput(before, after) {
  const previous = String(before || '')
  const current = String(after || '')
  if (!current || current === previous) return ''
  if (!previous) return current
  if (current.startsWith(previous)) {
    return current.slice(previous.length).trim()
  }
  // The bounded process buffer may roll over during a noisy request. In that
  // uncommon case the current buffer is still a better request diagnostic
  // than discarding the backend-owned explanation altogether.
  return current
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

function contentBlockFromUpdate(update) {
  if (
    update?.sessionUpdate !== 'agent_message_chunk'
    || !update.content
    || typeof update.content !== 'object'
  ) return null
  return update.content
}

function processError(label, message, stderr = '') {
  return new AgentError(
    `${label} ACP ${message}${stderr ? `：${stderr}` : ''}`,
    { protocol: 'acp' },
  )
}

function timeoutDuration(timeoutMs) {
  return timeoutMs >= 1000
    ? `${Math.round(timeoutMs / 1000)} 秒`
    : `${timeoutMs} 毫秒`
}

export class AcpProcessClient {
  constructor({
    label,
    command,
    args = [],
    cwd,
    env = process.env,
    prepare,
    timeoutMs = 300_000,
    spawnImpl = spawn,
    treeSpawnImpl = spawn,
    platform = process.platform,
    killImpl = process.kill,
    onPermission,
    onElicitation,
    onUpdate,
    sanitizeProcessOutput,
    formatRequestError,
  }) {
    this.label = label
    this.command = command
    this.args = args
    this.cwd = cwd
    this.env = env
    this.prepare = prepare
    this.timeoutMs = timeoutMs
    this.spawn = spawnImpl
    this.treeSpawn = treeSpawnImpl
    this.platform = platform
    this.kill = killImpl
    this.onPermission = onPermission
    this.onElicitation = onElicitation
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
    this.processTreeCleanups = new WeakMap()
  }

  get capabilities() {
    return this.initializeResult?.agentCapabilities || {}
  }

  get agentInfo() {
    return this.initializeResult?.agentInfo || null
  }

  get ready() {
    return Boolean(
      this.initializeResult
      && this.context
      && this.child?.exitCode == null
      && this.child?.signalCode == null
    )
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
    await this.prepare?.()
    const isWindows = this.platform === 'win32'
    // .exe 文件不需要 cmd.exe 包装；直接 spawn 避免路径含空格时
    // cmd.exe 将第一个空格前的内容误解析为命令名。
    const commandExt = isWindows ? extname(String(this.command)).toLowerCase() : ''
    const useShell = isWindows && commandExt !== '.exe'
    const child = this.spawn(this.command, this.args, {
        cwd: this.cwd,
        env: this.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: useShell,
        detached: !isWindows,
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
      .onRequest(
        acp.methods.client.elicitation.create,
        context => this.handleElicitation(context.params, context.signal),
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
        const failure = processError(
          this.label,
          `进程启动失败（${error.message}）`,
        )
        failure.code = error?.code
        failure.cause = error
        reject(failure)
      })
      child.once('exit', (code, signal) => {
        processLogger.warn('acp.process_exited', { code, signal })
        this.stopProcessTree(child).catch(error => {
          processLogger.error('acp.process_tree_cleanup_failed', { error })
        })
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
            clientCapabilities: {
              elicitation: { form: {} },
            },
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
      // stdout may close a tick before the child 'exit' event. In that race
      // the ACP SDK reports only "connection closed" even though the native
      // backend already wrote an actionable explanation to stderr. Preserve
      // that backend-owned diagnostic without teaching the client any
      // product-specific error strings.
      const stderr = cleanProcessOutput(
        this.stderr,
        this.sanitizeProcessOutput,
      )
      const failure = stderr && !(error instanceof AgentError)
        ? processError(this.label, '初始化失败', stderr)
        : error
      processLogger.error('acp.initialization_failed', { error: failure })
      connection.close(failure)
      await this.stopProcessTree(child)
      this.connection = null
      this.context = null
      this.initializeResult = null
      throw failure
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

  async handleElicitation(params, signal) {
    if (!this.onElicitation) return { action: 'cancel' }
    const sessionId = String(params?.sessionId || '')
    const active = this.activePrompts.get(sessionId)
    active?.pauseTimeout?.()
    try {
      return await this.onElicitation(params, {
        signal,
        session: this.sessions.get(sessionId),
      })
    } finally {
      active?.resumeTimeout?.()
    }
  }

  handleUpdate(notification) {
    const sessionId = String(notification?.sessionId || '')
    const update = notification?.update
    if (!sessionId || !update) return
    applySessionMetadataUpdate(this.sessions.get(sessionId), update)
    const active = this.activePrompts.get(sessionId)
    const text = textFromUpdate(update)
    if (active && text) active.text.push(text)
    const contentBlock = contentBlockFromUpdate(update)
    if (active && contentBlock) active.contentBlocks.push(contentBlock)
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
    let processOutputBefore = ''
    try {
      await this.start()
      processOutputBefore = cleanProcessOutput(
        this.stderr,
        this.sanitizeProcessOutput,
      )
      return await this.context.request(method, params, {
        signal: this.requestSignal(signal, timeoutMs),
      })
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      const isRequestError = error?.name === 'RequestError'
      const processOutput = cleanProcessOutput(
        this.stderr,
        this.sanitizeProcessOutput,
      )
      const stderr = isRequestError
        ? requestProcessOutput(processOutputBefore, processOutput)
        : processOutput
      const details = requestErrorDetails(error)
      const body = [details, stderr]
        .filter((value, index, values) => value && values.indexOf(value) === index)
        .join('\n')
      throw new AgentError(
        `${this.label} ACP ${method} 失败：${
          requestErrorMessage(error, this.formatRequestError)
        }${
          stderr ? `：${stderr}` : ''
        }`,
        {
          body,
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
    // 原地合并，保持对象身份稳定：adapter 会在同一引用上维护运行时路由字段
    // （onEvent/ownerId/coordinationRunId 等）。若每次 resume 都替换对象，
    // 权限请求会拿到旧闭包快照，被路由到已完成的旧任务上。
    const session = this.sessions.get(id) || {}
    Object.assign(session, details, { sessionId: id })
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
    await this.start()
    assertMcpServerCapabilities({
      label: this.label,
      capabilities: this.capabilities,
      mcpServers,
    })
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
    assertMcpServerCapabilities({
      label: this.label,
      capabilities: this.capabilities,
      mcpServers,
    })
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
    await this.start()
    const promptBlocks = normalizeAcpPrompt(prompt)
    assertPromptCapabilities(promptBlocks, this.capabilities)
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
      contentBlocks: [],
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
      let response
      try {
        response = await this.request(
          acp.methods.agent.session.prompt,
          {
            sessionId: id,
            prompt: promptBlocks,
          },
          { signal: combined, timeoutMs: 0 },
        )
      } catch (error) {
        if (!timeoutController.signal.aborted || signal?.aborted) throw error
        throw new AgentError(
          `${this.label} ACP 请求超时（${timeoutDuration(timeoutMs)}）`,
          { status: 504, protocol: 'acp' },
        )
      }
      if (timeoutController.signal.aborted && !signal?.aborted) {
        throw new AgentError(
          `${this.label} ACP 请求超时（${timeoutDuration(timeoutMs)}）`,
          { status: 504, protocol: 'acp' },
        )
      }
      const content = active.text.join('').trim()
      return {
        content,
        contentBlocks: active.contentBlocks,
        response,
      }
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
    if (child) await this.stopProcessTree(child)
    this.child = null
  }

  processGroupAlive(pid) {
    if (this.platform === 'win32' || !Number.isInteger(pid)) return false
    try {
      this.kill(-pid, 0)
      return true
    } catch (error) {
      return error?.code === 'EPERM'
    }
  }

  signalPosixProcessGroup(child, signal) {
    if (!Number.isInteger(child?.pid)) return
    try {
      this.kill(-child.pid, signal)
    } catch {
      if (child.exitCode == null && child.signalCode == null) {
        child.kill(signal)
      }
    }
  }

  runTaskkill(pid, force = false) {
    return new Promise(resolvePromise => {
      const args = ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])]
      let killer
      try {
        killer = this.treeSpawn('taskkill', args, {
          windowsHide: true,
          stdio: 'ignore',
        })
      } catch {
        resolvePromise(false)
        return
      }
      let settled = false
      const finish = ok => {
        if (settled) return
        settled = true
        resolvePromise(ok)
      }
      killer.once?.('error', () => finish(false))
      killer.once?.('exit', code => finish(code === 0))
      // The returned Promise is part of the shutdown contract. Keep taskkill
      // referenced until it reports exit; a pending Promise alone does not
      // keep the Node 22 event loop alive on Windows.
    })
  }

  async stopProcessTree(child, graceMs = PROCESS_TREE_GRACE_MS) {
    if (!child || !Number.isInteger(child.pid)) return
    const existing = this.processTreeCleanups.get(child)
    if (existing) return existing
    const cleanup = (async () => {
      if (this.platform === 'win32') {
        if (!await this.runTaskkill(child.pid)) {
          await this.runTaskkill(child.pid, true)
        }
        return
      }
      this.signalPosixProcessGroup(child, 'SIGTERM')
      const deadline = Date.now() + graceMs
      while (this.processGroupAlive(child.pid) && Date.now() < deadline) {
        await new Promise(resolvePromise => {
          setTimeout(resolvePromise, Math.min(PROCESS_TREE_POLL_MS, graceMs))
        })
      }
      if (this.processGroupAlive(child.pid)) {
        this.signalPosixProcessGroup(child, 'SIGKILL')
      }
    })()
    this.processTreeCleanups.set(child, cleanup)
    return cleanup
  }
}
