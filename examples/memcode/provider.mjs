import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  MEMORY_PROVIDER_PROTOCOL_VERSION,
} from 'qwen-audio-agent/memory-provider'

const SCOPES = new Set(['user', 'memory'])
const DEFAULT_DOCUMENTS = Object.freeze({ user: '# USER', memory: '# MEMORY' })

function clean(value, limit = 8_000) {
  return [...String(value || '').replaceAll('\0', '').trim()].slice(0, limit).join('')
}

function exactText(value) {
  return String(value ?? '').replaceAll('\0', '').replace(/\r\n?/g, '\n')
}

function digest(value, length = 16) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, length)
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

function required(value, name) {
  const normalized = String(value || '').trim()
  if (!normalized) throw new Error(`Memcode ${name} is required`)
  return normalized
}

function providerError(code) {
  return Object.assign(new Error(`Memcode operation failed (${code}); retry or check the service.`), { code })
}

export function memcodeBinding(apiUrl, apiKey) {
  const url = new URL(required(apiUrl, 'apiUrl'))
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Memcode URL must be an HTTP(S) endpoint without credentials')
  }
  return digest(JSON.stringify([url.href.replace(/\/+$/, ''), required(apiKey, 'apiKey')]), 64)
}

function publicDocument(scope, content) {
  return {
    id: `${scope}_document`,
    scope,
    content,
    format: 'markdown',
    revision: digest(content),
    editable: true,
  }
}

function mutationText(prepared) {
  const lines = [
    'The user explicitly updated long-term memory. Apply these changes as authoritative.',
  ]
  for (const item of prepared) {
    lines.push(`Document: ${item.scope}`)
    for (const edit of item.edits) {
      if (edit.newText) {
        lines.push(`Replace exactly: ${edit.oldText}`)
        lines.push(`With: ${edit.newText}`)
      } else {
        lines.push(`Delete exactly: ${edit.oldText}`)
      }
    }
    if (item.append) lines.push(`Append: ${item.append}`)
  }
  return lines.join('\n')
}

/**
 * Optional personal Memcode adapter for qwen-audio-agent's MemoryProvider v2.
 *
 * list() is backed by a small mode-0600 snapshot because the Realtime prompt
 * path is synchronous. Memcode remains the semantic store and receives every
 * accepted explicit update through the credential-derived personal v2 API.
 */
export class MemcodeMemoryProvider {
  constructor({
    client,
    binding,
    ownerId = 'user_personal',
    stateFile = resolve(
      process.cwd(),
      '.qwen-audio',
      'runtime',
      'memory',
      'memcode',
      'snapshot.json',
    ),
    maxChars = 8_000,
    timeoutMs = 30_000,
    pollMs = 1_000,
  } = {}) {
    if (!client || ['ingestV2', 'getIngestStatusV2', 'searchV2'].some(name => typeof client[name] !== 'function')) {
      throw new TypeError('Memcode client must implement ingestV2(), getIngestStatusV2(), and searchV2()')
    }
    this.client = client
    this.binding = required(binding, 'credential binding')
    this.ownerId = required(ownerId, 'ownerId')
    this.stateFile = resolve(stateFile)
    this.maxChars = Math.max(1_000, Math.min(32_000, Number(maxChars) || 8_000))
    this.lastErrorCode = null
    this.timeoutMs = Math.max(1, Number(timeoutMs) || 30_000)
    this.pollMs = Math.max(1, Number(pollMs) || 1_000)
    this.pending = null
    this.lane = Promise.resolve()
    this.documents = this.#readSnapshot()
  }

  describe() {
    return {
      protocolVersion: MEMORY_PROVIDER_PROTOCOL_VERSION,
      key: 'memcode',
      label: 'Memcode',
      capabilities: {
        semanticQuery: true,
        sessionObservation: false,
        audioStreamObservation: false,
      },
    }
  }

  #assertOwner(ownerId) {
    if (String(ownerId || '') !== this.ownerId) {
      const error = new Error('Memcode provider rejected an unexpected Gateway owner')
      error.code = 'owner_mismatch'
      throw error
    }
  }

  #readSnapshot() {
    if (!existsSync(this.stateFile)) return { ...DEFAULT_DOCUMENTS }
    const parsed = JSON.parse(readFileSync(this.stateFile, 'utf8'))
    if (parsed?.owner_id !== this.ownerId) {
      throw new Error('Memcode snapshot belongs to a different Gateway owner')
    }
    if (parsed.version !== 2 || parsed.binding !== this.binding) {
      throw new Error('Memcode snapshot credential binding differs; use a separate state file')
    }
    this.pending = parsed.pending || null
    if (this.pending) {
      this.#validateDocuments(this.pending.documents)
      if (!this.pending.key || !this.pending.identity || typeof this.pending.input?.user_query !== 'string') {
        throw new Error('Invalid pending Memcode operation; existing data was not modified')
      }
    }
    return this.#validateDocuments(parsed.documents)
  }

  #validateDocuments(documents) {
    for (const scope of SCOPES) {
      if (typeof documents?.[scope] !== 'string' || [...documents[scope]].length > this.maxChars) {
        throw new Error('Invalid or oversized Memcode snapshot; existing data was not modified')
      }
    }
    return { user: documents.user, memory: documents.memory }
  }

  #persistSnapshot(documents) {
    mkdirSync(dirname(this.stateFile), { recursive: true, mode: 0o700 })
    const temporary = `${this.stateFile}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify({
      version: 2,
      binding: this.binding,
      owner_id: this.ownerId,
      documents,
      pending: this.pending,
    }, null, 2)}\n`, { mode: 0o600 })
    chmodSync(temporary, 0o600)
    renameSync(temporary, this.stateFile)
  }

  #publicDocuments(scope = null) {
    return [...SCOPES]
      .filter(name => !scope || name === scope)
      .map(name => publicDocument(name, this.documents[name]))
  }

  list(ownerId, { scope = null } = {}) {
    this.#assertOwner(ownerId)
    return this.#publicDocuments(SCOPES.has(scope) ? scope : null)
  }

  async apply(ownerId, changes = [], context = {}) {
    this.#assertOwner(ownerId)
    return this.#serialize(() => this.#apply(changes, context))
  }

  #serialize(operation) {
    const result = this.lane.then(operation)
    this.lane = result.catch(() => {})
    return result
  }

  async #request(operation, deadline) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw providerError('timeout')
    let timer
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise((_, reject) => { timer = setTimeout(() => reject(providerError('timeout')), remaining) }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  async #resume() {
    if (!this.pending) return
    const deadline = Date.now() + this.timeoutMs
    try {
      if (!this.pending.jobId) {
        const receipt = await this.#request(() => this.client.ingestV2(
          this.pending.input, { idempotencyKey: this.pending.key },
        ), deadline)
        if (!receipt?.job_id) throw providerError('invalid_receipt')
        this.pending.jobId = String(receipt.job_id)
        this.#persistSnapshot(this.documents)
      }
      while (true) {
        const result = await this.#request(() => this.client.getIngestStatusV2(this.pending.jobId), deadline)
        if (result?.status === 'completed') break
        if (['failed', 'cancelled', 'dead_lettered'].includes(result?.status)) {
          this.pending = null
          this.#persistSnapshot(this.documents)
          throw providerError('ingest_failed')
        }
        await delay(Math.min(this.pollMs, Math.max(0, deadline - Date.now())))
      }
      const next = this.#validateDocuments(this.pending.documents)
      const pending = this.pending
      this.pending = null
      try { this.#persistSnapshot(next) } catch (error) {
        this.pending = pending
        throw error
      }
      this.documents = next
      this.lastErrorCode = null
    } catch (error) {
      // SDK errors can contain upstream text or credentials; do not propagate them.
      this.lastErrorCode = ['timeout', 'ingest_failed', 'invalid_receipt'].includes(error?.code)
        ? error.code : 'request_failed'
      throw providerError(this.lastErrorCode)
    }
  }

  async #apply(changes, context) {
    const identity = digest(JSON.stringify({ changes, sessionId: context?.sessionId || '', turnId: context?.turnId || '' }), 64)
    const retry = this.pending?.identity === identity
    const pendingChanged = this.pending?.changed
    await this.#resume()
    if (retry) return { changed: pendingChanged, documents: this.#publicDocuments() }
    if (!Array.isArray(changes) || !changes.length) {
      throw new Error('at least one memory change is required')
    }
    const next = { ...this.documents }
    const seen = new Set()
    const prepared = []
    let changed = 0

    for (const change of changes) {
      const scope = String(change?.document || '')
      if (!SCOPES.has(scope)) throw new Error(`unsupported memory scope: ${scope}`)
      if (seen.has(scope)) throw new Error(`duplicate memory document: ${scope}`)
      seen.add(scope)
      if (change.expectedRevision && change.expectedRevision !== digest(next[scope])) {
        const error = new Error('memory document changed; reload before editing')
        error.code = 'revision_conflict'
        throw error
      }

      let content = next[scope]
      const edits = []
      for (const edit of change.edits || []) {
        const oldText = exactText(edit?.old_text)
        if (!oldText) throw new Error('memory edit requires old_text')
        if ([...oldText].length > this.maxChars) throw new Error('memory edit exceeds the limit')
        const matches = count(content, oldText)
        if (matches !== 1) {
          const error = new Error(matches ? 'memory edit is ambiguous' : 'memory edit not found')
          error.code = matches ? 'ambiguous_edit' : 'edit_not_found'
          throw error
        }
        const newText = exactText(edit?.new_text)
        if ([...newText].length > this.maxChars) throw new Error('memory edit exceeds the limit')
        content = content.replace(oldText, () => newText)
        edits.push({ oldText, newText })
      }
      const append = exactText(change.append).trim()
      if ([...append].length > this.maxChars) throw new Error('memory append exceeds the limit')
      if (append) content = `${content.trim()}\n\n${append}`
      content = exactText(content).trim()
      if ([...content].length > this.maxChars) {
        throw new Error(`memory document exceeds ${this.maxChars} characters`)
      }
      if (content !== next[scope]) changed += 1
      next[scope] = content
      prepared.push({ scope, edits, append })
    }

    if (!changed) return { changed: 0, documents: this.#publicDocuments() }

    // Each new operation gets a new key, even if a user later repeats the same
    // edit. Only recovery of this persisted operation reuses its key.
    const idempotencyKey = `qwen-audio:${randomUUID()}`
    this.pending = {
      identity,
      key: idempotencyKey,
      changed,
      documents: next,
      input: {
        user_query: mutationText(prepared),
        effort_level: 'high',
      },
    }
    try { this.#persistSnapshot(this.documents) } catch (error) {
      this.pending = null
      throw error
    }
    await this.#resume()
    return { changed, documents: this.#publicDocuments() }
  }

  async query(ownerId, query, { scope = null, limit = 5 } = {}) {
    this.#assertOwner(ownerId)
    return this.#serialize(() => this.#query(query, { scope, limit }))
  }

  async #query(query, { scope, limit }) {
    await this.#resume()
    try {
      const response = await this.#request(() => this.client.searchV2({
        query: required(query, 'query'),
        top_k: Math.max(1, Math.min(10, Math.trunc(Number(limit) || 5))),
        include_original_chunks: false,
      }), Date.now() + this.timeoutMs)
      const results = Array.isArray(response?.results) ? response.results : []
      const context = results
        .map(item => clean(item?.content, 2_000))
        .filter(Boolean)
        .map(content => `- ${content}`)
        .join('\n')
      this.lastErrorCode = null
      return {
        memories: this.#publicDocuments(SCOPES.has(scope) ? scope : null),
        context: clean(context, this.maxChars),
      }
    } catch (error) {
      this.lastErrorCode = error?.code === 'timeout' ? 'timeout' : 'request_failed'
      throw providerError(this.lastErrorCode)
    }
  }

  health() {
    return {
      ok: this.lastErrorCode === null && !this.pending,
      configured: true,
      pending: Boolean(this.pending),
      ...(this.lastErrorCode ? { error_code: this.lastErrorCode } : {}),
    }
  }

  async close() { await this.lane }
}
