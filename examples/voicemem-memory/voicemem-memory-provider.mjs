import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { MEMORY_PROVIDER_PROTOCOL_VERSION } from 'qwen-audio-agent/memory-provider'

const EXAMPLE_DIRECTORY = dirname(fileURLToPath(import.meta.url))
const SCOPES = new Set(['user', 'memory'])
const SENSITIVE = /(?:api[_ -]?key|secret|token|password|passwd|credential|密码|密钥|验证码|令牌|证件号|身份证|详细住址|病史|病历|诊断|用药|\bsk-[a-z0-9_-]+|\b\d{11,19}\b)/iu

export function applyRecommendedDashScopeConfiguration(env = process.env) {
  if (String(env.OPENAI_API_KEY || '').trim()) return false
  const apiKey = String(env.DASHSCOPE_API_KEY || '').trim()
  if (!apiKey) return false
  env.OPENAI_API_KEY = apiKey
  env.OPENAI_BASE_URL ||= 'https://dashscope.aliyuncs.com/compatible-mode/v1'
  env.VOICEMEM_CHAT_MODEL ||= 'qwen3.8-flash'
  env.VOICEMEM_EMBEDDING_MODEL ||= 'text-embedding-v4'
  env.VOICEMEM_EMBED_DIM ||= '1024'
  env.VOICEMEM_MEMORY_LANGUAGE ||= 'zh'
  return true
}

function ownerKey(ownerId) {
  return createHash('sha256').update(String(ownerId || 'anonymous')).digest('hex')
}

function clean(value, limit = 8_000) {
  return [...String(value || '').replaceAll('\0', '').trim()].slice(0, limit).join('')
}

function count(content, needle) {
  if (!needle) return 0
  let matches = 0
  let offset = 0
  while ((offset = content.indexOf(needle, offset)) >= 0) {
    matches += 1
    offset += needle.length
  }
  return matches
}

function defaultPythonCommand(env) {
  if (String(env.VOICEMEM_PYTHON || '').trim()) return env.VOICEMEM_PYTHON
  const bundledEnvironment = join(
    EXAMPLE_DIRECTORY,
    '.venv',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
  )
  if (existsSync(bundledEnvironment)) return bundledEnvironment
  return process.platform === 'win32' ? 'python' : 'python3'
}

class JsonLineSidecar {
  constructor({ command, args, cwd, env, timeoutMs = 30_000 }) {
    this.command = command
    this.args = args
    this.cwd = cwd
    this.env = env
    this.timeoutMs = timeoutMs
    this.child = null
    this.pending = new Map()
    this.lastError = null
    this.lastStderr = null
  }

  start() {
    if (this.child) return
    this.lastError = null
    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    createInterface({ input: this.child.stdout }).on('line', line => {
      let message
      try { message = JSON.parse(line) } catch { return }
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(message.error))
      else pending.resolve(message.result)
    })
    this.child.stderr.on('data', chunk => {
      this.lastStderr = clean(chunk, 500)
    })
    this.child.once('error', error => {
      this.lastError = clean(error.message, 500)
    })
    this.child.once('exit', (code, signal) => {
      const error = new Error(
        this.lastError || this.lastStderr || `VoiceMem sidecar exited (${signal || code})`,
      )
      if (code && !this.lastError) this.lastError = clean(error.message, 500)
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(error)
      }
      this.pending.clear()
      this.child = null
    })
  }

  request(method, params = {}, { timeoutMs = this.timeoutMs } = {}) {
    this.start()
    const id = randomUUID()
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rejectRequest(new Error(`VoiceMem ${method} timed out`))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer })
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, error => {
        if (!error) return
        clearTimeout(timer)
        this.pending.delete(id)
        rejectRequest(error)
      })
    })
  }

  async close({ timeoutMs = this.timeoutMs } = {}) {
    if (!this.child) return
    try { await this.request('close', {}, { timeoutMs }) } catch {}
    this.child?.kill()
    this.child = null
  }
}

/**
 * Example MemoryProvider backed by VoiceMem.
 *
 * Stable user-authored preferences and facts stay in a tiny adapter-owned
 * control snapshot so list() remains synchronous. VoiceMem owns automatic
 * learning, consolidation, and semantic recall. Both are private
 * implementation details behind the same Gateway contract.
 */
export class VoiceMemMemoryProvider {
  constructor({
    stateDirectory = resolve(process.cwd(), '.qwen-audio', 'voicemem'),
    python = null,
    sidecarPath = join(EXAMPLE_DIRECTORY, 'sidecar', 'server.py'),
    timeoutMs = 30_000,
    backgroundTimeoutMs = 120_000,
    env = process.env,
    sidecar = null,
  } = {}) {
    this.stateDirectory = resolve(stateDirectory)
    this.profileDirectory = join(this.stateDirectory, 'profiles')
    mkdirSync(this.profileDirectory, { recursive: true })
    this.cache = new Map()
    this.backgroundOperations = new Map()
    this.pendingObservations = new Map()
    this.backgroundTimeoutMs = Math.max(timeoutMs, backgroundTimeoutMs)
    this.sidecar = sidecar || new JsonLineSidecar({
      command: python || defaultPythonCommand(env),
      args: [sidecarPath, '--state-dir', this.stateDirectory],
      cwd: EXAMPLE_DIRECTORY,
      env: { ...env },
      timeoutMs,
    })
  }

  describe() {
    return {
      protocolVersion: MEMORY_PROVIDER_PROTOCOL_VERSION,
      key: 'voicemem',
      label: 'VoiceMem',
      capabilities: {
        semanticQuery: true,
        sessionObservation: true,
      },
    }
  }

  #path(ownerId) {
    return join(this.profileDirectory, `${ownerKey(ownerId)}.json`)
  }

  #beginBackground(owner) {
    this.backgroundOperations.set(
      owner,
      (this.backgroundOperations.get(owner) || 0) + 1,
    )
  }

  #endBackground(owner) {
    const remaining = (this.backgroundOperations.get(owner) || 1) - 1
    if (remaining > 0) this.backgroundOperations.set(owner, remaining)
    else this.backgroundOperations.delete(owner)
  }

  #read(ownerId) {
    const key = ownerKey(ownerId)
    if (this.cache.has(key)) return this.cache.get(key)
    let data = { user: '# USER', memory: '# MEMORY' }
    const path = this.#path(ownerId)
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      data = {
        user: clean(parsed.user) || '# USER',
        memory: clean(parsed.memory) || '# MEMORY',
      }
    }
    this.cache.set(key, data)
    return data
  }

  #documents(ownerId, scope = null) {
    const data = this.#read(ownerId)
    return [...SCOPES]
      .filter(name => !scope || name === scope)
      .map(name => ({
        id: `${name}_document`,
        scope: name,
        content: data[name],
        format: 'markdown',
        revision: createHash('sha256').update(data[name]).digest('hex'),
      }))
  }

  list(ownerId, { scope = null } = {}) {
    return this.#documents(ownerId, SCOPES.has(scope) ? scope : null)
  }

  apply(ownerId, changes = []) {
    if (!Array.isArray(changes) || !changes.length) {
      throw new Error('at least one memory change is required')
    }
    const current = this.#read(ownerId)
    const next = { ...current }
    let changed = 0
    for (const change of changes) {
      const scope = String(change?.document || '')
      if (!SCOPES.has(scope)) throw new Error(`unsupported memory scope: ${scope}`)
      let content = next[scope]
      for (const edit of change.edits || []) {
        const oldText = String(edit?.old_text || '')
        const matches = count(content, oldText)
        if (matches !== 1) {
          const error = new Error(matches ? 'memory edit is ambiguous' : 'memory edit not found')
          error.code = matches ? 'ambiguous_edit' : 'edit_not_found'
          throw error
        }
        content = content.replace(oldText, String(edit?.new_text || ''))
      }
      const append = clean(change.append)
      if (append) content = `${content.trim()}\n\n${append}`
      content = clean(content)
      if (content !== next[scope]) changed += 1
      next[scope] = content
    }
    if (changed) {
      const path = this.#path(ownerId)
      const temporary = `${path}.${process.pid}.tmp`
      writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
      renameSync(temporary, path)
      this.cache.set(ownerKey(ownerId), next)
    }
    return { changed, documents: this.#documents(ownerId) }
  }

  async query(ownerId, query, { scope = null, limit = 5 } = {}) {
    const memories = this.#documents(
      ownerId,
      SCOPES.has(scope) ? scope : null,
    )
    // VoiceMem's local Qdrant store permits one process per memory root. Never
    // queue an interactive tool call behind slower session consolidation;
    // explicit preferences remain available from the synchronous snapshot.
    const owner = ownerKey(ownerId)
    if (this.backgroundOperations.has(owner)) return { memories, context: '' }
    const context = await this.sidecar.request('recall', {
      ownerId: owner,
      query: clean(query, 2_000),
      topK: Math.max(1, Math.min(10, Number(limit) || 5)),
    })
    return {
      memories,
      context: clean(context, 8_000),
    }
  }

  async observe(ownerId, exchange, context = {}) {
    const messages = Array.isArray(exchange?.messages)
      ? exchange.messages.map(message => ({
          id: clean(message?.id, 240),
          role: message?.role === 'assistant' ? 'assistant' : 'user',
          content: clean(message?.content, 4_000),
        })).filter(message => message.content && !SENSITIVE.test(message.content))
      : []
    if (!messages.length) return { observed: false }
    const owner = ownerKey(ownerId)
    const observationKey = createHash('sha256').update(JSON.stringify({
      ownerId: owner,
      messages,
    })).digest('hex')
    const pending = this.pendingObservations.get(observationKey)
    if (pending) return pending
    this.#beginBackground(owner)
    const operation = this.sidecar.request('observe', {
      ownerId: owner,
      sessionId: clean(context.sessionId, 200),
      messages,
    }, { timeoutMs: this.backgroundTimeoutMs }).finally(() => {
      this.#endBackground(owner)
      this.pendingObservations.delete(observationKey)
    })
    this.pendingObservations.set(observationKey, operation)
    return operation
  }

  async flush(ownerId, context = {}) {
    const owner = ownerKey(ownerId)
    this.#beginBackground(owner)
    try {
      await this.sidecar.request('flush', {
        ownerId: owner,
        sessionId: clean(context.sessionId, 200),
      }, { timeoutMs: this.backgroundTimeoutMs })
    } finally {
      this.#endBackground(owner)
    }
  }

  health() {
    return {
      ok: !this.sidecar.lastError,
      ...(this.sidecar.lastError ? { warning: this.sidecar.lastError } : {}),
    }
  }

  close() {
    return this.sidecar.close({ timeoutMs: this.backgroundTimeoutMs })
  }
}
