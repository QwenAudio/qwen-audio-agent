import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import {
  MEMORY_PROVIDER_PROTOCOL_VERSION,
} from '../../server/src/memory/provider.mjs'

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
  } = {}) {
    if (!client || typeof client.ingestV2 !== 'function' || typeof client.searchV2 !== 'function') {
      throw new TypeError('Memcode client must implement ingestV2() and searchV2()')
    }
    this.client = client
    this.ownerId = required(ownerId, 'ownerId')
    this.stateFile = resolve(stateFile)
    this.maxChars = Math.max(1_000, Math.min(32_000, Number(maxChars) || 8_000))
    this.lastErrorCode = null
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
    return {
      user: clean(parsed.documents?.user) || DEFAULT_DOCUMENTS.user,
      memory: clean(parsed.documents?.memory) || DEFAULT_DOCUMENTS.memory,
    }
  }

  #persistSnapshot(documents) {
    mkdirSync(dirname(this.stateFile), { recursive: true, mode: 0o700 })
    const temporary = `${this.stateFile}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify({
      version: 1,
      owner_id: this.ownerId,
      documents,
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
        content = content.replace(oldText, newText)
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

    const idempotencyKey = `qwen-audio:${digest(JSON.stringify({
      ownerId: this.ownerId,
      before: this.documents,
      changes,
      sessionId: context?.sessionId || '',
      turnId: context?.turnId || '',
    }), 64)}`
    try {
      await this.client.ingestV2({
        user_query: mutationText(prepared),
        effort_level: 'high',
      }, { idempotencyKey })
      this.#persistSnapshot(next)
      this.documents = next
      this.lastErrorCode = null
      return { changed, documents: this.#publicDocuments() }
    } catch (error) {
      this.lastErrorCode = error?.constructor?.name || 'request_failed'
      throw error
    }
  }

  async query(ownerId, query, { scope = null, limit = 5 } = {}) {
    this.#assertOwner(ownerId)
    try {
      const response = await this.client.searchV2({
        query: required(query, 'query'),
        mode: 'memories',
        top_k: Math.max(1, Math.min(10, Number(limit) || 5)),
        include_original_chunks: false,
      })
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
      this.lastErrorCode = error?.constructor?.name || 'request_failed'
      throw error
    }
  }

  health() {
    return {
      ok: this.lastErrorCode === null,
      configured: true,
      ...(this.lastErrorCode ? { error_code: this.lastErrorCode } : {}),
    }
  }

  async close() {}
}
