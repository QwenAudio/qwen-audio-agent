import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { resolve } from 'node:path'
import {
  replaceFileSync,
  withFileTransaction,
} from '../../../../shared/file-transaction-lock.mjs'

const STORE_VERSION = 1
const DOCUMENT_ID = /^[a-z0-9][a-z0-9._:-]{0,79}$/u

function clone(value) {
  return structuredClone(value)
}

function ownerDigest(ownerId) {
  return createHash('sha256').update(String(ownerId || '')).digest('hex').slice(0, 32)
}

function clean(value, maxChars) {
  return [...String(value || '').replace(/\s+/g, ' ').trim()]
    .slice(0, maxChars)
    .join('')
}

function normalizeDocument(input, {
  maxChunksPerDocument,
  maxChunkChars,
  maxDocumentChars,
  now,
  existing = null,
}) {
  const id = String(input?.id || '').trim().toLowerCase()
  if (!DOCUMENT_ID.test(id)) throw new Error('Knowledge document id is invalid.')
  const title = clean(input?.title, 300)
  const mimeType = clean(input?.mimeType, 120).toLowerCase()
  const revision = clean(input?.revision, 128)
  if (!title || !mimeType || !revision) {
    throw new Error('Knowledge document title, MIME type, and revision are required.')
  }
  const candidates = Array.isArray(input?.chunks) ? input.chunks : []
  if (!candidates.length || candidates.length > maxChunksPerDocument) {
    throw new Error('Knowledge document chunks are missing or exceed the limit.')
  }
  let totalChars = 0
  const chunks = candidates.map((candidate, index) => {
    const text = String(candidate?.text || '').trim()
    const chars = [...text].length
    if (!text || chars > maxChunkChars) {
      throw new Error('Knowledge chunk is empty or exceeds the limit.')
    }
    totalChars += chars
    return {
      id: `${id}:chunk_${index + 1}`,
      ordinal: index,
      text,
    }
  })
  if (totalChars > maxDocumentChars) {
    throw new Error('Knowledge document exceeds the stored text limit.')
  }
  const timestamp = Number(now())
  if (!Number.isFinite(timestamp)) {
    throw new Error('Knowledge document timestamp is invalid.')
  }
  return {
    id,
    title,
    mimeType,
    revision,
    source: {
      kind: clean(input?.source?.kind, 40) || 'document',
      label: clean(input?.source?.label, 300) || title,
    },
    chunks,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  }
}

function documentSummary(document) {
  return {
    id: document.id,
    title: document.title,
    mimeType: document.mimeType,
    revision: document.revision,
    source: { ...document.source },
    chunkCount: document.chunks.length,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  }
}

function invalidStore(message = 'Knowledge store has an invalid document.') {
  const error = new Error(message)
  error.code = 'knowledge_store_invalid'
  return error
}

export class FileKnowledgeStore {
  constructor({
    directory,
    maxDocumentsPerOwner = 200,
    maxChunksPerDocument = 512,
    maxChunkChars = 4_000,
    maxDocumentChars = 500_000,
    now = () => Date.now(),
    onWarning = () => {},
  } = {}) {
    if (!directory) throw new Error('FileKnowledgeStore requires a directory')
    this.directory = resolve(directory)
    this.maxDocumentsPerOwner = maxDocumentsPerOwner
    this.maxChunksPerDocument = maxChunksPerDocument
    this.maxChunkChars = maxChunkChars
    this.maxDocumentChars = maxDocumentChars
    this.now = now
    this.onWarning = onWarning
    this.warning = null
  }

  describe() {
    return { key: 'local-files', label: 'Local JSON Knowledge Store' }
  }

  pathFor(ownerId) {
    const owner = String(ownerId || '').trim()
    if (!owner) throw new Error('Knowledge owner id is required.')
    return resolve(this.directory, `owner_${ownerDigest(owner)}.json`)
  }

  read(path) {
    let state
    try {
      state = JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') return { version: STORE_VERSION, documents: [] }
      this.warn(`Unable to read knowledge store: ${error.message}`)
      const failure = new Error('Knowledge store is unavailable or corrupt.')
      failure.code = 'knowledge_store_unavailable'
      throw failure
    }
    if (state?.version !== STORE_VERSION || !Array.isArray(state.documents)) {
      this.warn('Knowledge store has an unsupported format.')
      throw invalidStore('Knowledge store has an unsupported format.')
    }
    if (state.documents.length > this.maxDocumentsPerOwner) {
      this.warn('Knowledge store exceeds the document limit.')
      throw invalidStore('Knowledge store exceeds the document limit.')
    }
    const ids = new Set()
    try {
      state.documents = state.documents.map(document => {
        if (ids.has(document?.id)) {
          throw invalidStore('Knowledge store contains duplicate document ids.')
        }
        ids.add(document?.id)
        const createdAt = Number(document?.createdAt)
        const updatedAt = Number(document?.updatedAt)
        if (!Number.isFinite(createdAt) || !Number.isFinite(updatedAt)) {
          throw invalidStore('Knowledge document timestamps are invalid.')
        }
        return {
          ...normalizeDocument(document, {
            maxChunksPerDocument: this.maxChunksPerDocument,
            maxChunkChars: this.maxChunkChars,
            maxDocumentChars: this.maxDocumentChars,
            now: () => updatedAt,
            existing: { createdAt },
          }),
          createdAt,
          updatedAt,
        }
      })
    } catch (error) {
      this.warn(`Knowledge store contains invalid data: ${error.message}`)
      if (error?.code === 'knowledge_store_invalid') throw error
      throw invalidStore()
    }
    return state
  }

  write(path, state) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, `${JSON.stringify(state)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      })
      replaceFileSync(temporary, path)
      chmodSync(path, 0o600)
      this.warning = null
    } finally {
      rmSync(temporary, { force: true })
    }
  }

  putDocument(ownerId, input) {
    const path = this.pathFor(ownerId)
    return withFileTransaction(path, () => {
      const state = this.read(path)
      const index = state.documents.findIndex(document => document.id === input?.id)
      if (index < 0 && state.documents.length >= this.maxDocumentsPerOwner) {
        throw new Error('Knowledge store document limit reached.')
      }
      const document = normalizeDocument(input, {
        maxChunksPerDocument: this.maxChunksPerDocument,
        maxChunkChars: this.maxChunkChars,
        maxDocumentChars: this.maxDocumentChars,
        now: this.now,
        existing: index >= 0 ? state.documents[index] : null,
      })
      if (index >= 0) state.documents[index] = document
      else state.documents.push(document)
      this.write(path, state)
      return clone(documentSummary(document))
    })
  }

  getDocument(ownerId, documentId) {
    const id = String(documentId || '').trim().toLowerCase()
    const document = this.read(this.pathFor(ownerId)).documents
      .find(candidate => candidate.id === id)
    return document ? clone(document) : null
  }

  listDocuments(ownerId) {
    return this.read(this.pathFor(ownerId)).documents
      .map(documentSummary)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(clone)
  }

  removeDocument(ownerId, documentId) {
    const path = this.pathFor(ownerId)
    const id = String(documentId || '').trim().toLowerCase()
    return withFileTransaction(path, () => {
      const state = this.read(path)
      const next = state.documents.filter(document => document.id !== id)
      if (next.length === state.documents.length) return false
      state.documents = next
      this.write(path, state)
      return true
    })
  }

  warn(message) {
    this.warning = { message, at: this.now() }
    try {
      this.onWarning(this.warning)
    } catch {
      // Diagnostics do not change persistence behavior.
    }
  }

  health() {
    return {
      ok: !this.warning,
      persistenceEnabled: true,
      warning: this.warning,
    }
  }

  close() {}
}
