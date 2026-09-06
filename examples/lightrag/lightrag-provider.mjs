import { basename } from 'node:path'
import {
  KNOWLEDGE_PROVIDER_PROTOCOL_VERSION,
} from 'qwen-audio-agent/knowledge-provider'
import { LightRagClient, LightRagHttpError } from './lightrag-client.mjs'

const TERMINAL_DOCUMENT_STATUSES = new Set(['PROCESSED', 'FAILED'])
const DEFAULT_POLL_INTERVAL_MS = 1_000
const DEFAULT_INGESTION_TIMEOUT_MS = 15 * 60_000
const DEFAULT_DELETION_TIMEOUT_MS = 2 * 60_000
const MAX_DOCUMENT_PAGES = 100
const QUERY_MODES = new Set(['local', 'global', 'hybrid', 'naive', 'mix'])

function clean(value) {
  return String(value || '').trim()
}

function positiveInteger(value, fallback) {
  const number = Math.trunc(Number(value))
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function abortableDelay(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', aborted)
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const aborted = () => {
      clearTimeout(timer)
      cleanup()
      reject(signal.reason)
    }
    signal?.addEventListener('abort', aborted, { once: true })
  })
}

function publicDocument(value) {
  const id = clean(value?.id)
  if (!id) return null
  const path = clean(value?.file_path)
  const filename = path ? basename(path) : ''
  const summary = clean(value?.content_summary)
  return {
    id,
    title: filename || summary || id,
    ...(filename ? { filename } : {}),
    ...(summary ? { gist: summary } : {}),
    ...(value?.status ? { status: clean(value.status).toLowerCase() } : {}),
    ...(value?.created_at ? { created_at: clean(value.created_at) } : {}),
    ...(value?.updated_at ? { updated_at: clean(value.updated_at) } : {}),
    source: 'lightrag',
    metadata: {
      ...(Number.isFinite(Number(value?.content_length))
        ? { content_length: Number(value.content_length) }
        : {}),
      ...(Number.isFinite(Number(value?.chunks_count))
        ? { chunks_count: Number(value.chunks_count) }
        : {}),
    },
  }
}

function publicUrl(value) {
  try {
    const url = new URL(clean(value))
    return ['http:', 'https:'].includes(url.protocol) ? url.href : ''
  } catch {
    return ''
  }
}

function ingestionError(documents) {
  const failed = documents.find(item => clean(item?.status).toUpperCase() === 'FAILED')
  const message = clean(failed?.error_msg) || 'LightRAG 文档索引失败。'
  return new LightRagHttpError(message, {
    code: 'lightrag_ingestion_failed',
  })
}

export class LightRagKnowledgeProvider {
  constructor({
    baseUrl,
    apiKey = '',
    workspace = '',
    queryMode = 'mix',
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    ingestionTimeoutMs = DEFAULT_INGESTION_TIMEOUT_MS,
    deletionTimeoutMs = DEFAULT_DELETION_TIMEOUT_MS,
    requestTimeoutMs,
    fetchImpl,
  } = {}) {
    this.client = new LightRagClient({
      baseUrl,
      apiKey,
      workspace,
      requestTimeoutMs,
      fetchImpl,
    })
    this.workspace = clean(workspace)
    this.queryMode = clean(queryMode) || 'mix'
    if (!QUERY_MODES.has(this.queryMode)) {
      throw new TypeError(
        `LIGHTRAG_QUERY_MODE must be one of: ${[...QUERY_MODES].join(', ')}`,
      )
    }
    this.pollIntervalMs = positiveInteger(pollIntervalMs, DEFAULT_POLL_INTERVAL_MS)
    this.ingestionTimeoutMs = positiveInteger(
      ingestionTimeoutMs,
      DEFAULT_INGESTION_TIMEOUT_MS,
    )
    this.deletionTimeoutMs = positiveInteger(
      deletionTimeoutMs,
      DEFAULT_DELETION_TIMEOUT_MS,
    )
  }

  describe() {
    return {
      protocolVersion: KNOWLEDGE_PROVIDER_PROTOCOL_VERSION,
      key: 'lightrag',
      label: 'LightRAG',
      capabilities: {
        filters: false,
        scores: false,
        citations: false,
        ingestion: true,
        management: true,
      },
    }
  }

  async health({ signal } = {}) {
    try {
      await this.client.request('/health', { signal })
      return { status: 'ready' }
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      return {
        status: 'unavailable',
        message: error?.message || 'LightRAG 服务不可用。',
      }
    }
  }

  async retrieve(request, context = {}) {
    const requestedBases = Array.isArray(request?.knowledgeBaseIds)
      ? request.knowledgeBaseIds.map(clean).filter(Boolean)
      : []
    if (
      requestedBases.length
      && (!this.workspace || !requestedBases.includes(this.workspace))
    ) {
      return { results: [] }
    }
    if (request?.filters && Object.keys(request.filters).length) {
      throw new LightRagHttpError('当前 LightRAG 示例不支持检索过滤条件。', {
        code: 'lightrag_filters_unsupported',
      })
    }
    const topK = Math.max(1, Math.min(8, Number(request?.topK) || 5))
    const response = await this.client.request('/query/data', {
      method: 'POST',
      body: {
        query: clean(request?.query),
        mode: this.queryMode,
        top_k: topK,
        chunk_top_k: topK,
      },
      signal: context.signal,
    })
    if (clean(response?.status).toLowerCase() === 'failure') {
      throw new LightRagHttpError(
        clean(response?.message) || 'LightRAG 检索失败。',
        { code: 'lightrag_retrieval_failed', retryable: true },
      )
    }
    const references = new Map(
      (response?.data?.references || []).map(item => [clean(item.reference_id), item]),
    )
    return {
      results: (response?.data?.chunks || []).slice(0, topK).flatMap((chunk, index) => {
        const content = clean(chunk?.content)
        const referenceId = clean(chunk?.reference_id)
        const reference = references.get(referenceId)
        const path = clean(chunk?.file_path ?? reference?.file_path)
        const id = clean(chunk?.chunk_id) || `${referenceId || 'chunk'}-${index + 1}`
        if (!content) return []
        const uri = publicUrl(path)
        return [{
          id,
          content,
          source: {
            ...(referenceId ? { id: referenceId } : {}),
            ...(path ? { title: basename(path), locator: path } : {}),
            ...(uri ? { uri } : {}),
          },
          metadata: {
            provider: 'lightrag',
            ...(referenceId ? { reference_id: referenceId } : {}),
          },
        }]
      }),
    }
  }

  async ingest(request, context = {}) {
    const sourcePath = clean(request?.source?.path ?? request?.path)
    if (!sourcePath) {
      throw new TypeError('LightRAG ingestion requires a local file path')
    }
    const uploaded = await this.client.uploadFile(sourcePath, {
      name: clean(request?.source?.name) || basename(sourcePath),
      signal: context.signal,
    })
    const trackId = clean(uploaded?.track_id)
    if (!trackId) {
      throw new LightRagHttpError('LightRAG 上传响应缺少 track_id。', {
        code: 'lightrag_invalid_upload_response',
      })
    }
    const deadline = Date.now() + this.ingestionTimeoutMs
    while (Date.now() < deadline) {
      const tracked = await this.client.request(
        `/documents/track_status/${encodeURIComponent(trackId)}`,
        { signal: context.signal },
      )
      const documents = Array.isArray(tracked?.documents) ? tracked.documents : []
      if (documents.some(item => clean(item?.status).toUpperCase() === 'FAILED')) {
        throw ingestionError(documents)
      }
      if (
        documents.length
        && documents.every(item => TERMINAL_DOCUMENT_STATUSES.has(
          clean(item?.status).toUpperCase(),
        ))
      ) {
        const document = publicDocument(documents[0])
        if (document) return { document }
      }
      await abortableDelay(this.pollIntervalMs, context.signal)
    }
    throw new LightRagHttpError('等待 LightRAG 完成文档索引超时。', {
      retryable: true,
      code: 'lightrag_ingestion_timeout',
    })
  }

  async list(_request, context = {}) {
    const documents = []
    let page = 1
    while (page <= MAX_DOCUMENT_PAGES) {
      const response = await this.client.request('/documents/paginated', {
        method: 'POST',
        body: {
          page,
          page_size: 200,
          sort_field: 'updated_at',
          sort_direction: 'desc',
        },
        signal: context.signal,
      })
      documents.push(...(response?.documents || []).map(publicDocument).filter(Boolean))
      if (!response?.pagination?.has_next) break
      page += 1
    }
    if (page > MAX_DOCUMENT_PAGES) {
      throw new LightRagHttpError(
        `LightRAG 文档列表超过 ${MAX_DOCUMENT_PAGES} 页，已停止继续读取。`,
        { code: 'lightrag_document_list_limit' },
      )
    }
    return { documents }
  }

  async remove(request, context = {}) {
    const documentId = clean(request?.documentId ?? request?.id)
    if (!documentId) throw new TypeError('LightRAG removal requires documentId')
    const response = await this.client.request('/documents/delete_document', {
      method: 'DELETE',
      body: {
        doc_ids: [documentId],
        delete_file: true,
        delete_llm_cache: false,
      },
      signal: context.signal,
    })
    if (response?.status !== 'deletion_started') {
      throw new LightRagHttpError(
        clean(response?.message) || 'LightRAG 暂时无法删除文档。',
        { retryable: response?.status === 'busy', code: 'lightrag_delete_rejected' },
      )
    }
    const deadline = Date.now() + this.deletionTimeoutMs
    while (Date.now() < deadline) {
      const documents = (await this.list({}, context)).documents
      if (!documents.some(item => item.id === documentId)) {
        return { removed: true, document: { id: documentId, title: documentId } }
      }
      await abortableDelay(this.pollIntervalMs, context.signal)
    }
    throw new LightRagHttpError('等待 LightRAG 完成文档删除超时。', {
      retryable: true,
      code: 'lightrag_deletion_timeout',
    })
  }
}

export function createLightRagKnowledgeProviderFromEnv(env = process.env) {
  return new LightRagKnowledgeProvider({
    baseUrl: env.LIGHTRAG_URL || 'http://127.0.0.1:9621',
    apiKey: env.LIGHTRAG_API_KEY,
    workspace: env.LIGHTRAG_WORKSPACE,
    queryMode: env.LIGHTRAG_QUERY_MODE,
    pollIntervalMs: env.LIGHTRAG_POLL_INTERVAL_MS,
    ingestionTimeoutMs: env.LIGHTRAG_INGESTION_TIMEOUT_MS,
    deletionTimeoutMs: env.LIGHTRAG_DELETION_TIMEOUT_MS,
    requestTimeoutMs: env.LIGHTRAG_REQUEST_TIMEOUT_MS,
  })
}
