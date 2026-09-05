import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import {
  MEMORY_PROVIDER_PROTOCOL_VERSION,
} from '../../memory-provider.mjs'

const SCOPES = new Set(['user', 'memory'])
const SENSITIVE = /(?:api[_ -]?key|secret|token|password|passwd|credential|密码|密钥|验证码|令牌|证件号|身份证|详细住址|病史|病历|诊断|用药|\bsk-[a-z0-9_-]+|\b\d{11,19}\b)/iu
const DEFAULT_SAMPLE_RATE = 16_000
const PCM_BYTES_PER_SAMPLE = 2

export function normalizeVoiceMemInputMode(value) {
  return String(value || '').trim().toLowerCase() === 'audio' ? 'audio' : 'text'
}

function wavBuffer(pcm, sampleRate) {
  const rate = Number.isFinite(sampleRate) && sampleRate > 0
    ? Math.floor(sampleRate)
    : DEFAULT_SAMPLE_RATE
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * PCM_BYTES_PER_SAMPLE, 28)
  header.writeUInt16LE(PCM_BYTES_PER_SAMPLE, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

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
 * Optional MemoryProvider connector for an externally installed VoiceMem.
 *
 * Stable user-authored preferences and facts stay in a tiny adapter-owned
 * control snapshot so list() remains synchronous. VoiceMem owns automatic
 * learning, consolidation, and semantic recall. Both are private
 * implementation details behind the same Gateway contract.
 */
export class VoiceMemProvider {
  constructor({
    stateDirectory = resolve(process.cwd(), '.qwen-audio', 'voicemem'),
    python = null,
    sidecarPath = null,
    timeoutMs = 30_000,
    backgroundTimeoutMs = 120_000,
    audioPreRollMs = 1_000,
    maxAudioTurnSeconds = 45,
    maxAudioSessionBytes = 24 * 1024 * 1024,
    env = process.env,
    sidecar = null,
  } = {}) {
    this.stateDirectory = resolve(stateDirectory)
    this.profileDirectory = join(this.stateDirectory, 'profiles')
    mkdirSync(this.profileDirectory, { recursive: true })
    this.cache = new Map()
    this.backgroundOperations = new Map()
    this.pendingObservations = new Map()
    this.inputMode = normalizeVoiceMemInputMode(env.VOICEMEM_INPUT_MODE)
    this.audioPreRollMs = Math.max(0, Math.min(2_000, Number(audioPreRollMs) || 0))
    this.maxAudioTurnSeconds = Math.max(1, Number(maxAudioTurnSeconds) || 45)
    this.maxAudioSessionBytes = Math.max(
      64 * 1024,
      Number(maxAudioSessionBytes) || 24 * 1024 * 1024,
    )
    this.audioSessions = new Map()
    this.audioStagingDirectory = join(this.stateDirectory, 'audio-staging')
    if (this.inputMode === 'audio') {
      mkdirSync(this.audioStagingDirectory, { recursive: true, mode: 0o700 })
    }
    this.backgroundTimeoutMs = Math.max(timeoutMs, backgroundTimeoutMs)
    const sidecarEnvironment = { ...env }
    applyRecommendedDashScopeConfiguration(sidecarEnvironment)
    const configuredSidecar = String(
      sidecarPath || sidecarEnvironment.VOICEMEM_SIDECAR || '',
    ).trim()
    if (!sidecar && !configuredSidecar) {
      throw new Error(
        'VoiceMem 需要外部 sidecar；请设置 VOICEMEM_SIDECAR 为其绝对路径',
      )
    }
    const resolvedSidecar = configuredSidecar ? resolve(configuredSidecar) : ''
    if (!sidecar && !existsSync(resolvedSidecar)) {
      throw new Error(`VoiceMem sidecar 不存在：${resolvedSidecar}`)
    }
    this.sidecar = sidecar || new JsonLineSidecar({
      command: python || defaultPythonCommand(sidecarEnvironment),
      args: [
        resolvedSidecar,
        '--state-dir',
        this.stateDirectory,
        '--input-mode',
        this.inputMode,
      ],
      cwd: dirname(resolvedSidecar),
      env: sidecarEnvironment,
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
        audioStreamObservation: this.inputMode === 'audio',
      },
    }
  }

  #audioSessionKey(ownerId, sessionId) {
    return `${ownerKey(ownerId)}\0${clean(sessionId, 200)}`
  }

  #audioSession(ownerId, context) {
    const sessionId = clean(context?.sessionId, 200)
    if (!sessionId) return null
    const key = this.#audioSessionKey(ownerId, sessionId)
    let state = this.audioSessions.get(key)
    if (!state) {
      state = {
        sampleRate: DEFAULT_SAMPLE_RATE,
        preRoll: [],
        preRollBytes: 0,
        active: null,
        completed: new Map(),
        completedBytes: 0,
      }
      this.audioSessions.set(key, state)
    }
    return state
  }

  #appendPreRoll(state, chunk) {
    const limit = Math.ceil(
      state.sampleRate * PCM_BYTES_PER_SAMPLE * this.audioPreRollMs / 1_000,
    )
    if (!limit) return
    const retained = chunk.length > limit ? chunk.subarray(chunk.length - limit) : chunk
    state.preRoll.push(retained)
    state.preRollBytes += retained.length
    while (state.preRollBytes > limit && state.preRoll.length) {
      const removed = state.preRoll.shift()
      state.preRollBytes -= removed.length
    }
  }

  #storeCompletedTurn(state, segment) {
    if (!segment?.turnId || !segment.bytes) return
    const prior = state.completed.get(segment.turnId)
    if (prior) state.completedBytes -= prior.bytes
    state.completed.set(segment.turnId, segment)
    state.completedBytes += segment.bytes
    while (
      state.completed.size > 20
      || state.completedBytes > this.maxAudioSessionBytes
    ) {
      const oldest = state.completed.entries().next().value
      if (!oldest) break
      state.completed.delete(oldest[0])
      state.completedBytes -= oldest[1].bytes
    }
  }

  observeAudio(ownerId, event = {}, context = {}) {
    if (this.inputMode !== 'audio') return { observed: false }
    const state = this.#audioSession(ownerId, context)
    if (!state) return { observed: false }
    const type = String(event.type || '')

    if (type === 'chunk') {
      const sampleRate = Number(event.sampleRate)
      if (Number.isFinite(sampleRate) && sampleRate > 0) state.sampleRate = sampleRate
      let chunk
      try { chunk = Buffer.from(String(event.audio || ''), 'base64') } catch { return { observed: false } }
      if (!chunk.length) return { observed: false }
      if (!state.active) {
        this.#appendPreRoll(state, chunk)
        return { observed: true }
      }
      const limit = Math.ceil(
        state.active.sampleRate * PCM_BYTES_PER_SAMPLE * this.maxAudioTurnSeconds,
      )
      if (state.active.bytes < limit) {
        const accepted = chunk.subarray(0, limit - state.active.bytes)
        state.active.chunks.push(accepted)
        state.active.bytes += accepted.length
      }
      return { observed: true }
    }

    if (type === 'speech_started') {
      state.active = {
        turnId: clean(event.turnId, 240),
        sampleRate: state.sampleRate,
        chunks: state.preRoll,
        bytes: state.preRollBytes,
      }
      state.preRoll = []
      state.preRollBytes = 0
      return { observed: true }
    }

    if (type === 'speech_stopped') {
      const segment = state.active
      state.active = null
      if (event.reason !== 'turn_invalid') this.#storeCompletedTurn(state, segment)
      return { observed: Boolean(segment) }
    }

    if (type === 'session_ended') {
      state.active = null
      state.preRoll = []
      state.preRollBytes = 0
      return { observed: true }
    }
    return { observed: false }
  }

  #takeAudioFiles(ownerId, sessionId, messages) {
    if (this.inputMode !== 'audio') return []
    const key = this.#audioSessionKey(ownerId, sessionId)
    const state = this.audioSessions.get(key)
    this.audioSessions.delete(key)
    if (!state) return []
    const paths = []
    for (const message of messages) {
      if (message.role !== 'user' || !message.turnId) continue
      const segment = state.completed.get(message.turnId)
      if (!segment?.bytes) continue
      const path = join(this.audioStagingDirectory, `${randomUUID()}.wav`)
      writeFileSync(path, wavBuffer(Buffer.concat(segment.chunks), segment.sampleRate), {
        mode: 0o600,
      })
      message.audioPath = path
      paths.push(path)
    }
    return paths
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
          turnId: clean(message?.turnId, 240),
        })).filter(message => message.content && !SENSITIVE.test(message.content))
      : []
    const owner = ownerKey(ownerId)
    const sessionId = clean(context.sessionId, 200)
    if (!messages.length) {
      if (this.inputMode === 'audio') {
        this.audioSessions.delete(this.#audioSessionKey(ownerId, sessionId))
      }
      return { observed: false }
    }
    const observationKey = createHash('sha256').update(JSON.stringify({
      ownerId: owner,
      messages,
      inputMode: this.inputMode,
    })).digest('hex')
    const pending = this.pendingObservations.get(observationKey)
    if (pending) return pending
    const audioPaths = this.#takeAudioFiles(ownerId, sessionId, messages)
    this.#beginBackground(owner)
    const finish = () => {
      for (const path of audioPaths) rmSync(path, { force: true })
      this.#endBackground(owner)
      this.pendingObservations.delete(observationKey)
    }
    let request
    try {
      request = this.sidecar.request('observe', {
        ownerId: owner,
        sessionId,
        messages,
      }, { timeoutMs: this.backgroundTimeoutMs })
    } catch (error) {
      finish()
      throw error
    }
    const operation = Promise.resolve(request).finally(finish)
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
      inputMode: this.inputMode,
      ...(this.sidecar.lastError ? { warning: this.sidecar.lastError } : {}),
    }
  }

  async close() {
    try {
      await this.sidecar.close({ timeoutMs: this.backgroundTimeoutMs })
    } finally {
      this.audioSessions.clear()
    }
  }
}
