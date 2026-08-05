import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'

const MAX_LISTS_PER_OWNER = 20
const MAX_ITEMS_PER_LIST = 100
const MAX_LIST_NAME_CHARS = 30
const MAX_ITEM_CHARS = 100
const MAX_RESULT_CANDIDATES = 10

function clean(value, maxChars) {
  return [...String(value || '').replace(/\s+/g, ' ').trim()]
    .slice(0, maxChars)
    .join('')
}

function listKey(value) {
  return clean(value, MAX_LIST_NAME_CHARS).toLocaleLowerCase()
}

function itemId(text) {
  return `item_${createHash('sha256').update(text).digest('hex').slice(0, 12)}`
}

function publicItem(text) {
  return { id: itemId(text), text }
}

function publicList(entry) {
  return {
    list: entry.name,
    count: entry.items.length,
    updated_at: entry.updatedAt,
  }
}

// Resolves a spoken list name against an owner's lists. Exact names win;
// otherwise a unique bidirectional substring match is accepted, while several
// partial matches are reported back as candidates for a clarifying question.
function resolveList(lists, name) {
  const key = listKey(name)
  if (!key) return { found: false, candidates: [] }
  if (lists.has(key)) return { found: true, key, list: lists.get(key) }
  const matchingKeys = [...lists.entries()]
    .filter(([entryKey]) => entryKey.includes(key) || key.includes(entryKey))
    .map(([entryKey]) => entryKey)
  if (matchingKeys.length === 1) {
    return { found: true, key: matchingKeys[0], list: lists.get(matchingKeys[0]) }
  }
  const candidates = (matchingKeys.length ? matchingKeys : [...lists.keys()])
    .slice(0, MAX_RESULT_CANDIDATES)
    .map(entryKey => lists.get(entryKey).name)
  return {
    found: false,
    ambiguous: matchingKeys.length > 1,
    candidates,
  }
}

// Matches one spoken item against a list's items using the same exact-first,
// unique-substring-fallback rule as list names.
function resolveItem(items, text) {
  const needle = clean(text, MAX_ITEM_CHARS).toLocaleLowerCase()
  if (!needle) return { found: false, matches: [] }
  const exact = items.filter(item => item.text.toLocaleLowerCase() === needle)
  if (exact.length === 1) return { found: true, item: exact[0] }
  const partial = exact.length ? exact : items.filter(item => (
    item.text.toLocaleLowerCase().includes(needle)
    || needle.includes(item.text.toLocaleLowerCase())
  ))
  if (partial.length === 1) return { found: true, item: partial[0] }
  return { found: false, matches: partial.map(item => item.text) }
}

export class FrontendNotesStore {
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
        this.quarantine(`前台清单文件不是有效的 JSON：${error.message}`)
        return
      }
      this.disablePersistence(`无法读取前台清单文件：${error.message}`)
      return
    }
    if (
      !parsed
      || parsed.version !== 1
      || !parsed.owners
      || typeof parsed.owners !== 'object'
      || Array.isArray(parsed.owners)
    ) {
      this.quarantine('前台清单文件格式无效')
      return
    }
    Object.entries(parsed.owners).forEach(([ownerId, lists]) => {
      if (!lists || typeof lists !== 'object') return
      const normalized = new Map()
      Object.entries(lists).slice(0, MAX_LISTS_PER_OWNER).forEach(([key, entry]) => {
        const safeKey = clean(key, MAX_LIST_NAME_CHARS).toLocaleLowerCase()
        const name = clean(entry?.name, MAX_LIST_NAME_CHARS)
        if (!safeKey || !name) return
        const items = []
        const seen = new Set()
        for (const item of (Array.isArray(entry?.items) ? entry.items : []).slice(0, MAX_ITEMS_PER_LIST)) {
          const text = clean(item?.text ?? (typeof item === 'string' ? item : ''), MAX_ITEM_CHARS)
          const id = typeof item?.id === 'string' && item.id ? item.id : itemId(text)
          if (!text || seen.has(id)) continue
          seen.add(id)
          items.push({
            id,
            text,
            addedAt: Number(item?.addedAt) || 0,
          })
        }
        if (!items.length) return
        normalized.set(safeKey, {
          name,
          items,
          createdAt: Number(entry?.createdAt) || this.now(),
          updatedAt: Math.max(
            ...items.map(item => item.addedAt || 0),
          ) || this.now(),
        })
      })
      if (normalized.size) {
        this.users.set(ownerId, normalized)
        this.ownerAccess.set(
          ownerId,
          Number(parsed.ownerAccess?.[ownerId]) || this.now(),
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
        `${reason}；原文件已隔离为 ${quarantinePath}，服务将使用空清单继续运行。`,
        quarantinePath,
      )
    } catch (error) {
      this.persistenceDisabled = true
      this.setWarning(
        `${reason}；隔离失败（${error.message}），已禁用清单持久化以保护原文件。`,
      )
    }
  }

  disablePersistence(message) {
    this.persistenceDisabled = true
    this.setWarning(`${message}；已禁用清单持久化，服务将继续运行。`)
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
      const owners = {}
      this.users.forEach((lists, ownerId) => {
        owners[ownerId] = {}
        lists.forEach((entry, key) => {
          owners[ownerId][key] = entry
        })
      })
      mkdirSync(dirname(this.filePath), { recursive: true })
      const temporary = `${this.filePath}.${process.pid}.tmp`
      const ownerAccess = Object.fromEntries(this.ownerAccess)
      writeFileSync(temporary, `${JSON.stringify({ version: 1, owners, ownerAccess }, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      })
      renameSync(temporary, this.filePath)
      return true
    } catch (error) {
      this.disablePersistence(`无法保存前台清单文件：${error.message}`)
      return false
    }
  }

  lists(ownerId) {
    this.pruneOwners()
    const safeOwnerId = String(ownerId)
    this.touch(safeOwnerId)
    return [...(this.users.get(safeOwnerId) || new Map()).values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(entry => publicList(entry))
  }

  show(ownerId, name) {
    this.touch(String(ownerId))
    const resolution = resolveList(this.users.get(String(ownerId)) || new Map(), name)
    if (!resolution.found || !name) {
      return resolution.ambiguous
        ? { status: 'ambiguous', candidates: resolution.candidates }
        : { status: 'not_found', candidates: resolution.candidates || [] }
    }
    return {
      status: 'ok',
      list: resolution.list.name,
      items: resolution.list.items.map(item => publicItem(item.text)),
    }
  }

  add(ownerId, { list, items = [] } = {}) {
    this.pruneOwners()
    const safeOwnerId = String(ownerId)
    const safeName = clean(list, MAX_LIST_NAME_CHARS)
    const safeItems = items
      .map(item => clean(item, MAX_ITEM_CHARS))
      .filter(Boolean)
    if (!safeName) throw new Error('list name is required')
    if (!safeItems.length) throw new Error('list items are required')
    let lists = this.users.get(safeOwnerId)
    if (!lists) {
      lists = new Map()
      this.users.set(safeOwnerId, lists)
    }
    const resolution = resolveList(lists, safeName)
    if (!resolution.found) {
      if (resolution.ambiguous) {
        return { status: 'ambiguous', candidates: resolution.candidates }
      }
      if (lists.size >= MAX_LISTS_PER_OWNER) {
        return { status: 'list_full', list: safeName }
      }
    }
    const previousLists = structuredClone(lists)
    if (!resolution.found) {
      lists.set(listKey(safeName), {
        name: safeName,
        items: [],
        createdAt: this.now(),
        updatedAt: this.now(),
      })
    }
    const listEntry = resolution.found
      ? resolution.list
      : lists.get(listKey(safeName))
    const added = []
    const duplicates = []
    for (const text of safeItems) {
      if (listEntry.items.length >= MAX_ITEMS_PER_LIST) {
        break
      }
      const normalized = text.toLocaleLowerCase()
      if (listEntry.items.some(item => item.text.toLocaleLowerCase() === normalized)) {
        duplicates.push(text)
        continue
      }
      const entry = { id: itemId(text), text, addedAt: this.now() }
      listEntry.items.push(entry)
      added.push(text)
    }
    listEntry.updatedAt = added.length ? this.now() : listEntry.updatedAt
    if (!added.length && !duplicates.length) {
      this.users.set(safeOwnerId, previousLists)
      return { status: 'list_full', list: listEntry.name }
    }
    if (!added.length) {
      this.users.set(safeOwnerId, previousLists)
      return { status: 'ok', list: listEntry.name, added, duplicates }
    }
    const previousAccess = this.ownerAccess.get(safeOwnerId)
    this.ownerAccess.set(safeOwnerId, this.now())
    this.pruneOwners({ persist: false })
    if (!this.persist()) {
      this.users.set(safeOwnerId, previousLists)
      if (previousAccess === undefined) this.ownerAccess.delete(safeOwnerId)
      else this.ownerAccess.set(safeOwnerId, previousAccess)
      throw new Error('frontend notes persistence is unavailable')
    }
    return { status: 'ok', list: listEntry.name, added, duplicates }
  }

  remove(ownerId, { list, items = [] } = {}) {
    this.pruneOwners()
    const safeOwnerId = String(ownerId)
    const safeItems = items
      .map(item => clean(item, MAX_ITEM_CHARS))
      .filter(Boolean)
    if (!safeItems.length) throw new Error('list items are required')
    const lists = this.users.get(safeOwnerId) || new Map()
    const resolution = resolveList(lists, list)
    if (!resolution.found) {
      return resolution.ambiguous
        ? { status: 'ambiguous', candidates: resolution.candidates }
        : { status: 'not_found', candidates: resolution.candidates || [] }
    }
    const listEntry = resolution.list
    const previousLists = structuredClone(lists)
    const removed = []
    const notFound = []
    const ambiguous = []
    for (const text of safeItems) {
      const match = resolveItem(listEntry.items, text)
      if (match.found) {
        listEntry.items = listEntry.items.filter(item => item.id !== match.item.id)
        removed.push(match.item.text)
      } else if (match.matches.length > 1) {
        ambiguous.push({ text, candidates: match.matches.slice(0, MAX_RESULT_CANDIDATES) })
      } else {
        notFound.push(text)
      }
    }
    if (!removed.length) {
      return {
        status: ambiguous.length ? 'ambiguous' : 'not_found',
        list: listEntry.name,
        removed,
        not_found: notFound,
        ambiguous,
      }
    }
    listEntry.updatedAt = this.now()
    const previousAccess = this.ownerAccess.get(safeOwnerId)
    this.ownerAccess.set(safeOwnerId, this.now())
    this.pruneOwners({ persist: false })
    if (!this.persist()) {
      this.users.set(safeOwnerId, previousLists)
      if (previousAccess === undefined) this.ownerAccess.delete(safeOwnerId)
      else this.ownerAccess.set(safeOwnerId, previousAccess)
      throw new Error('frontend notes persistence is unavailable')
    }
    return {
      status: ambiguous.length ? 'ambiguous' : 'ok',
      list: listEntry.name,
      removed,
      not_found: notFound,
      ambiguous,
    }
  }

  clear(ownerId, list) {
    this.pruneOwners()
    const safeOwnerId = String(ownerId)
    const lists = this.users.get(safeOwnerId) || new Map()
    const resolution = resolveList(lists, list)
    if (!resolution.found) {
      return resolution.ambiguous
        ? { status: 'ambiguous', candidates: resolution.candidates }
        : { status: 'not_found', candidates: resolution.candidates || [] }
    }
    const listEntry = resolution.list
    if (!listEntry.items.length) {
      return { status: 'ok', list: listEntry.name, removed: 0 }
    }
    const removed = listEntry.items.length
    const previous = structuredClone(listEntry.items)
    listEntry.items = []
    listEntry.updatedAt = this.now()
    this.ownerAccess.set(safeOwnerId, this.now())
    if (!this.persist()) {
      listEntry.items = previous
      throw new Error('frontend notes persistence is unavailable')
    }
    return { status: 'ok', list: listEntry.name, removed }
  }

  drop(ownerId, list) {
    this.pruneOwners()
    const safeOwnerId = String(ownerId)
    const lists = this.users.get(safeOwnerId) || new Map()
    const resolution = resolveList(lists, list)
    if (!resolution.found) {
      return resolution.ambiguous
        ? { status: 'ambiguous', candidates: resolution.candidates }
        : { status: 'not_found', candidates: resolution.candidates || [] }
    }
    const name = resolution.list.name
    const key = resolution.key
    const previousLists = structuredClone(lists)
    const previousAccess = this.ownerAccess.get(safeOwnerId)
    lists.delete(key)
    if (!lists.size) this.users.delete(safeOwnerId)
    this.ownerAccess.set(safeOwnerId, this.now())
    if (!this.persist()) {
      this.users.set(safeOwnerId, previousLists)
      if (previousAccess === undefined) this.ownerAccess.delete(safeOwnerId)
      else this.ownerAccess.set(safeOwnerId, previousAccess)
      throw new Error('frontend notes persistence is unavailable')
    }
    return { status: 'ok', list: name }
  }
}
