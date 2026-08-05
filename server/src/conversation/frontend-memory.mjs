import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import { MEMORY_STORE_SCOPES, scopeMeta } from '../core/memory-scopes.mjs'

const MAX_KEY_CHARS = 64
const MEMORY_STORE_SCOPE_SET = new Set(MEMORY_STORE_SCOPES)
const MAX_TOTAL_ENTRIES = MEMORY_STORE_SCOPES.reduce(
  (total, scope) => total + scopeMeta(scope).maxEntries,
  0,
)
const MAX_QUERY_CHARS = Math.max(
  ...MEMORY_STORE_SCOPES.map(scope => scopeMeta(scope).maxChars),
)

function clean(value, maxChars) {
  return [...String(value || '').replace(/\s+/g, ' ').trim()]
    .slice(0, maxChars)
    .join('')
}

function normalizeScope(value, fallback = 'long_term') {
  const scope = String(value || fallback).trim().toLowerCase()
  if (!MEMORY_STORE_SCOPE_SET.has(scope)) throw new Error(`unsupported memory scope: ${scope}`)
  return scope
}

function entryScope(entry) {
  return MEMORY_STORE_SCOPE_SET.has(entry?.scope) ? entry.scope : 'long_term'
}

function scopeLimits(scope) {
  const meta = scopeMeta(scope)
  return {
    maxEntries: meta.maxEntries,
    maxChars: meta.maxChars,
    label: meta.label,
  }
}

// Enforce the per-scope entry cap. The check applies whenever the write adds
// an entry to the target scope; an in-place update of an entry already in that
// scope keeps the count unchanged and is always allowed. Counting by scope
// (not by key existence) prevents cross-scope content collisions from
// bypassing the cap.
function assertScopeCapacity(entries, safeKey, targetScope, limits) {
  const existing = entries.get(safeKey)
  if (existing && entryScope(existing) === targetScope) return
  const scopeCount = [...entries.values()].filter(entry => (
    entryScope(entry) === targetScope
  )).length
  if (scopeCount >= limits.maxEntries) {
    throw new Error(`每个用户最多保存 ${limits.maxEntries} 条${limits.label}`)
  }
}

function memoryId(value) {
  return `mem_${createHash('sha256').update(value).digest('hex').slice(0, 16)}`
}

function publicEntry(entry) {
  return {
    id: memoryId(entry.value),
    scope: entryScope(entry),
    content: entry.value,
    updated_at: entry.updatedAt,
    editable: true,
  }
}

export class FrontendMemoryStore {
  constructor({
    filePath = null,
    maxOwners = 1000,
    ownerTtlMs = 0,
    now = () => Date.now(),
    onWarning = warning => console.warn(warning.message),
  } = {}) {
    this.filePath = filePath
    this.maxOwners = maxOwners
    this.ownerTtlMs = ownerTtlMs
    this.now = now
    this.onWarning = onWarning
    this.users = new Map()
    this.ownerAccess = new Map()
    this.warning = null
    this.persistenceDisabled = false
    if (filePath) this.load()
  }

  load() {
    let parsed
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') return
      if (error instanceof SyntaxError) {
        this.quarantine(`前台记忆文件不是有效的 JSON：${error.message}`)
        return
      }
      this.disablePersistence(`无法读取前台记忆文件：${error.message}`)
      return
    }
    if (
      !parsed
      || parsed.version !== 1
      || !parsed.users
      || typeof parsed.users !== 'object'
      || Array.isArray(parsed.users)
    ) {
      this.quarantine('前台记忆文件格式无效')
      return
    }
    Object.entries(parsed.users).forEach(([ownerId, entries]) => {
      if (!entries || typeof entries !== 'object') return
      const normalized = new Map()
      Object.entries(entries)
        .slice(0, MAX_TOTAL_ENTRIES)
        .forEach(([key, entry]) => {
          const safeKey = clean(key, MAX_KEY_CHARS)
          const scope = entryScope(entry)
          const value = clean(entry?.value, scopeLimits(scope).maxChars)
          if (!safeKey || !value) return
          normalized.set(safeKey, {
            value,
            scope,
            updatedAt: Number(entry?.updatedAt) || Date.now(),
          })
        })
      if (normalized.size) {
        this.users.set(ownerId, normalized)
        const latestEntry = Math.max(...[...normalized.values()].map(entry => entry.updatedAt))
        this.ownerAccess.set(
          ownerId,
          Number(parsed.ownerAccess?.[ownerId]) || latestEntry || this.now(),
        )
      }
    })
    this.pruneOwners({ persist: false })
  }

  quarantine(reason) {
    const quarantinePath = `${this.filePath}.corrupt-${this.now()}`
    try {
      renameSync(this.filePath, quarantinePath)
      this.setWarning(
        `${reason}；原文件已隔离为 ${quarantinePath}，服务将使用空记忆继续运行。`,
        quarantinePath,
      )
    } catch (error) {
      this.persistenceDisabled = true
      this.setWarning(
        `${reason}；隔离失败（${error.message}），已禁用记忆持久化以保护原文件。`,
      )
    }
  }

  disablePersistence(message) {
    this.persistenceDisabled = true
    this.setWarning(`${message}；已禁用记忆持久化，服务将继续运行。`)
  }

  setWarning(message, quarantinePath = null) {
    this.warning = { message, quarantinePath, at: this.now() }
    try {
      this.onWarning?.(this.warning)
    } catch {
      // Diagnostics must not prevent the voice service from starting.
    }
  }

  health() {
    return {
      ok: !this.warning,
      persistenceEnabled: Boolean(this.filePath) && !this.persistenceDisabled,
      warning: this.warning,
      owners: this.users.size,
    }
  }

  touch(ownerId) {
    if (this.users.has(ownerId)) this.ownerAccess.set(ownerId, this.now())
  }

  pruneOwners({ persist = true } = {}) {
    const now = this.now()
    let changed = false
    this.ownerAccess.forEach((lastAccessedAt, ownerId) => {
      if (!(this.ownerTtlMs > 0)) return
      if (now - lastAccessedAt < this.ownerTtlMs) return
      this.ownerAccess.delete(ownerId)
      changed = this.users.delete(ownerId) || changed
    })
    while (this.users.size > this.maxOwners) {
      const oldestOwner = [...this.users.keys()]
        .sort((a, b) => (
          Number(this.ownerAccess.get(a) || 0) - Number(this.ownerAccess.get(b) || 0)
        ))[0]
      if (!oldestOwner) break
      this.users.delete(oldestOwner)
      this.ownerAccess.delete(oldestOwner)
      changed = true
    }
    if (changed && persist) this.persist()
    return changed
  }

  persist() {
    if (!this.filePath) return true
    if (this.persistenceDisabled) return false
    try {
      const users = {}
      this.users.forEach((entries, ownerId) => {
        users[ownerId] = Object.fromEntries(entries)
      })
      mkdirSync(dirname(this.filePath), { recursive: true })
      const temporary = `${this.filePath}.${process.pid}.tmp`
      const ownerAccess = Object.fromEntries(this.ownerAccess)
      writeFileSync(temporary, `${JSON.stringify({ version: 1, users, ownerAccess }, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      })
      renameSync(temporary, this.filePath)
      return true
    } catch (error) {
      this.disablePersistence(`无法保存前台记忆文件：${error.message}`)
      return false
    }
  }

  list(ownerId, { query = '', limit = 20, scope = null } = {}) {
    this.pruneOwners()
    const safeOwnerId = String(ownerId)
    this.touch(safeOwnerId)
    const needle = clean(query, MAX_QUERY_CHARS).toLocaleLowerCase()
    const filteredScope = scope ? normalizeScope(scope) : null
    return [...(this.users.get(safeOwnerId) || new Map()).entries()]
      .filter(([key, entry]) => (
        (!filteredScope || entryScope(entry) === filteredScope)
        && (
          !needle
          || key.toLocaleLowerCase().includes(needle)
          || entry.value.toLocaleLowerCase().includes(needle)
        )
      ))
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      .slice(0, Math.min(64, Math.max(1, Number(limit) || 20)))
      .map(([, entry]) => publicEntry(entry))
  }

  remember(ownerId, content, { scope } = {}) {
    this.pruneOwners()
    const safeOwnerId = String(ownerId)
    const targetScope = normalizeScope(scope)
    const limits = scopeLimits(targetScope)
    const safeValue = clean(content, limits.maxChars)
    if (!safeValue) throw new Error('memory content is required')
    let entries = this.users.get(safeOwnerId)
    if (!entries) {
      entries = new Map()
      this.users.set(safeOwnerId, entries)
    }
    const existingKey = [...entries.entries()].find(([, entry]) => (
      entry.value.toLocaleLowerCase() === safeValue.toLocaleLowerCase()
    ))?.[0]
    const safeKey = existingKey || memoryId(safeValue).slice(0, MAX_KEY_CHARS)
    assertScopeCapacity(entries, safeKey, targetScope, limits)
    const previousEntry = entries.get(safeKey)
    const previousAccess = this.ownerAccess.get(safeOwnerId)
    const entry = { value: safeValue, scope: targetScope, updatedAt: this.now() }
    entries.set(safeKey, entry)
    this.ownerAccess.set(safeOwnerId, this.now())
    this.pruneOwners({ persist: false })
    if (!this.persist()) {
      if (previousEntry) entries.set(safeKey, previousEntry)
      else entries.delete(safeKey)
      if (!entries.size) this.users.delete(safeOwnerId)
      if (previousAccess === undefined) this.ownerAccess.delete(safeOwnerId)
      else this.ownerAccess.set(safeOwnerId, previousAccess)
      throw new Error('frontend memory persistence is unavailable')
    }
    return publicEntry(entry)
  }

  replace(ownerId, { ids = [], content, scope } = {}) {
    this.pruneOwners()
    const safeOwnerId = String(ownerId)
    const targetScope = normalizeScope(scope)
    const limits = scopeLimits(targetScope)
    const safeValue = clean(content, limits.maxChars)
    const targets = new Set(
      ids.map(id => clean(id, MAX_KEY_CHARS).toLocaleLowerCase()).filter(Boolean),
    )
    if (!safeValue) throw new Error('memory content is required')
    if (!targets.size) throw new Error('memory ids are required')
    const entries = this.users.get(safeOwnerId)
    if (!entries) return { replaced: 0, memory: null }
    const matchedKeys = [...entries.entries()]
      .filter(([key, entry]) => (
        targets.has(key.toLocaleLowerCase())
        || targets.has(memoryId(entry.value).toLocaleLowerCase())
      ))
      .map(([key]) => key)
    if (!matchedKeys.length) return { replaced: 0, memory: null }

    const previousEntries = new Map(entries)
    const previousAccess = this.ownerAccess.get(safeOwnerId)
    matchedKeys.forEach(key => entries.delete(key))
    const existingKey = [...entries.entries()].find(([, entry]) => (
      entry.value.toLocaleLowerCase() === safeValue.toLocaleLowerCase()
    ))?.[0]
    const safeKey = existingKey || memoryId(safeValue).slice(0, MAX_KEY_CHARS)
    try {
      assertScopeCapacity(entries, safeKey, targetScope, limits)
    } catch (error) {
      this.users.set(safeOwnerId, previousEntries)
      if (previousAccess === undefined) this.ownerAccess.delete(safeOwnerId)
      else this.ownerAccess.set(safeOwnerId, previousAccess)
      throw error
    }
    const entry = { value: safeValue, scope: targetScope, updatedAt: this.now() }
    entries.set(safeKey, entry)
    this.ownerAccess.set(safeOwnerId, this.now())
    if (!this.persist()) {
      this.users.set(safeOwnerId, previousEntries)
      if (previousAccess === undefined) this.ownerAccess.delete(safeOwnerId)
      else this.ownerAccess.set(safeOwnerId, previousAccess)
      throw new Error('frontend memory persistence is unavailable')
    }
    return {
      replaced: matchedKeys.length,
      memory: publicEntry(entry),
    }
  }

  forget(ownerId, { query = '', all = false, scope = null } = {}) {
    const safeOwnerId = String(ownerId)
    const needle = clean(query, MAX_QUERY_CHARS).toLocaleLowerCase()
    const filteredScope = scope ? normalizeScope(scope) : null
    const entries = this.users.get(safeOwnerId)
    if (!entries) return 0
    const previousEntries = new Map(entries)
    const previousAccess = this.ownerAccess.get(safeOwnerId)
    if (all) {
      const count = filteredScope
        ? [...entries.values()].filter(entry => (
            entryScope(entry) === filteredScope
          )).length
        : entries.size
      if (filteredScope) {
        for (const [key, entry] of entries) {
          if (entryScope(entry) === filteredScope) entries.delete(key)
        }
        if (entries.size) this.touch(safeOwnerId)
        else {
          this.users.delete(safeOwnerId)
          this.ownerAccess.delete(safeOwnerId)
        }
      } else {
        this.users.delete(safeOwnerId)
        this.ownerAccess.delete(safeOwnerId)
      }
      if (!this.persist()) {
        this.users.set(safeOwnerId, previousEntries)
        if (previousAccess !== undefined) {
          this.ownerAccess.set(safeOwnerId, previousAccess)
        }
        throw new Error('frontend memory persistence is unavailable')
      }
      return count
    }
    if (!needle) return 0
    let removed = 0
    for (const [key, entry] of entries) {
      if (
        (!filteredScope || entryScope(entry) === filteredScope)
        && (
          key.toLocaleLowerCase() === needle
          || memoryId(entry.value).toLocaleLowerCase() === needle
          || entry.value.toLocaleLowerCase().includes(needle)
        )
      ) {
        entries.delete(key)
        removed += 1
      }
    }
    if (!entries.size) {
      this.users.delete(safeOwnerId)
      this.ownerAccess.delete(safeOwnerId)
    } else {
      this.touch(safeOwnerId)
    }
    if (removed && !this.persist()) {
      this.users.set(safeOwnerId, previousEntries)
      if (previousAccess !== undefined) {
        this.ownerAccess.set(safeOwnerId, previousAccess)
      }
      throw new Error('frontend memory persistence is unavailable')
    }
    return removed
  }
}
