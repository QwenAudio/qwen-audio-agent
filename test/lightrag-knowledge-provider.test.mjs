import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  LightRagKnowledgeProvider,
} from '../examples/lightrag/lightrag-provider.mjs'

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function queuedFetch(responses) {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options })
    const next = responses.shift()
    if (!next) throw new Error(`Unexpected request: ${url}`)
    return typeof next === 'function' ? next(url, options) : next
  }
  return { calls, fetchImpl }
}

test('maps LightRAG raw chunks without leaking graph or transport objects', async () => {
  const transport = queuedFetch([json({
    status: 'success',
    data: {
      entities: [{ entity_name: 'private graph object' }],
      relationships: [{ description: 'private edge' }],
      chunks: [{
        chunk_id: 'chunk-1',
        content: 'Release requires two reviewers.',
        file_path: '/inputs/release-guide.pdf',
        reference_id: 'ref-1',
      }],
      references: [{ reference_id: 'ref-1', file_path: '/inputs/release-guide.pdf' }],
    },
    metadata: { private_provider_data: true },
  })])
  const provider = new LightRagKnowledgeProvider({
    baseUrl: 'http://127.0.0.1:9621',
    apiKey: 'secret',
    workspace: 'personal',
    fetchImpl: transport.fetchImpl,
  })

  const result = await provider.retrieve({ query: 'release rules', topK: 3 })

  assert.deepEqual(result, {
    results: [{
      id: 'chunk-1',
      content: 'Release requires two reviewers.',
      source: {
        id: 'ref-1',
        title: 'release-guide.pdf',
        locator: '/inputs/release-guide.pdf',
      },
      metadata: { provider: 'lightrag', reference_id: 'ref-1' },
    }],
  })
  assert.equal(transport.calls[0].url, 'http://127.0.0.1:9621/query/data')
  assert.equal(transport.calls[0].options.headers['X-API-Key'], 'secret')
  assert.equal(transport.calls[0].options.headers['LIGHTRAG-WORKSPACE'], 'personal')
  assert.deepEqual(JSON.parse(transport.calls[0].options.body), {
    query: 'release rules',
    mode: 'mix',
    top_k: 3,
    chunk_top_k: 3,
  })
  assert.equal(JSON.stringify(result).includes('private graph object'), false)
})

test('waits for asynchronous LightRAG ingestion and keeps track_id private', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qwaudio-lightrag-'))
  const filePath = join(directory, 'manual.md')
  writeFileSync(filePath, '# Manual')
  const transport = queuedFetch([
    (_url, options) => {
      assert.equal(options.body instanceof FormData, true)
      return json({ status: 'success', track_id: 'track-private' })
    },
    json({
      track_id: 'track-private',
      documents: [{ id: 'doc-1', status: 'PROCESSING' }],
    }),
    json({
      track_id: 'track-private',
      documents: [{
        id: 'doc-1',
        status: 'PROCESSED',
        file_path: 'manual.md',
        content_summary: 'A manual',
        content_length: 8,
        chunks_count: 1,
      }],
    }),
  ])
  const provider = new LightRagKnowledgeProvider({
    baseUrl: 'http://127.0.0.1:9621',
    fetchImpl: transport.fetchImpl,
    pollIntervalMs: 1,
  })
  try {
    const result = await provider.ingest({
      source: { type: 'file', path: filePath, name: 'manual.md' },
    })
    assert.deepEqual(result, {
      document: {
        id: 'doc-1',
        title: 'manual.md',
        filename: 'manual.md',
        gist: 'A manual',
        status: 'processed',
        source: 'lightrag',
        metadata: { content_length: 8, chunks_count: 1 },
      },
    })
    assert.equal(JSON.stringify(result).includes('track-private'), false)
    assert.match(transport.calls[2].url, /track_status\/track-private$/u)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('normalizes paginated documents and waits for asynchronous deletion', async () => {
  const document = {
    id: 'doc-1',
    status: 'PROCESSED',
    file_path: 'manual.pdf',
    content_summary: 'Manual',
  }
  const transport = queuedFetch([
    json({ documents: [document], pagination: { has_next: false } }),
    json({ status: 'deletion_started', doc_id: 'doc-1' }),
    json({ documents: [document], pagination: { has_next: false } }),
    json({ documents: [], pagination: { has_next: false } }),
  ])
  const provider = new LightRagKnowledgeProvider({
    baseUrl: 'http://127.0.0.1:9621',
    fetchImpl: transport.fetchImpl,
    pollIntervalMs: 1,
  })

  assert.deepEqual(await provider.list(), {
    documents: [{
      id: 'doc-1',
      title: 'manual.pdf',
      filename: 'manual.pdf',
      gist: 'Manual',
      status: 'processed',
      source: 'lightrag',
      metadata: {},
    }],
  })
  assert.deepEqual(await provider.remove({ documentId: 'doc-1' }), {
    removed: true,
    document: { id: 'doc-1', title: 'doc-1' },
  })
  assert.deepEqual(JSON.parse(transport.calls[1].options.body), {
    doc_ids: ['doc-1'],
    delete_file: true,
    delete_llm_cache: false,
  })
})

test('reports unavailable health and stops ingestion polling when aborted', async () => {
  const unavailable = new LightRagKnowledgeProvider({
    baseUrl: 'http://127.0.0.1:9621',
    fetchImpl: async () => { throw new Error('offline') },
  })
  assert.deepEqual(await unavailable.health(), {
    status: 'unavailable',
    message: '无法连接 LightRAG 服务。',
  })

  const directory = mkdtempSync(join(tmpdir(), 'qwaudio-lightrag-abort-'))
  const filePath = join(directory, 'manual.md')
  writeFileSync(filePath, '# Manual')
  const transport = queuedFetch([
    json({ status: 'success', track_id: 'track-1' }),
    json({ documents: [{ id: 'doc-1', status: 'PROCESSING' }] }),
  ])
  const provider = new LightRagKnowledgeProvider({
    baseUrl: 'http://127.0.0.1:9621',
    fetchImpl: transport.fetchImpl,
    pollIntervalMs: 100,
  })
  const controller = new AbortController()
  const pending = provider.ingest({ source: { path: filePath } }, {
    signal: controller.signal,
  })
  setTimeout(() => controller.abort(new DOMException('cancelled', 'AbortError')), 5)
  try {
    await assert.rejects(pending, error => error?.name === 'AbortError')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('rejects unsupported query modes before opening a connection', () => {
  assert.throws(
    () => new LightRagKnowledgeProvider({
      baseUrl: 'http://127.0.0.1:9621',
      queryMode: 'bypass',
    }),
    /LIGHTRAG_QUERY_MODE must be one of/u,
  )
})

test('does not turn caller cancellation into an unavailable health status', async () => {
  const controller = new AbortController()
  controller.abort(new DOMException('cancelled', 'AbortError'))
  const provider = new LightRagKnowledgeProvider({
    baseUrl: 'http://127.0.0.1:9621',
    fetchImpl: async (_url, { signal }) => {
      throw signal.reason
    },
  })
  await assert.rejects(
    provider.health({ signal: controller.signal }),
    error => error?.name === 'AbortError',
  )
})
