import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test, { afterEach } from 'node:test'
import { MemcodeMemoryProvider, memcodeBinding } from './provider.mjs'
import { MemcodeClient } from 'memcode-sdk'
import { execFileSync } from 'node:child_process'

const directories = []
afterEach(() => directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })))

function fixture() {
  const calls = { ingest: [], search: [] }
  const client = {
    async ingestV2(input, options) {
      calls.ingest.push({ input, options })
      return { job_id: 'job-1', status: 'processing' }
    },
    async getIngestStatusV2() { return { status: 'completed' } },
    async searchV2(input) {
      calls.search.push(input)
      return {
        results: [
          { content: 'The user prefers concise answers.', score: 0.9 },
          { content: '', score: 0.8 },
        ],
      }
    },
  }
  const directory = mkdtempSync(join(tmpdir(), 'qwen-memcode-'))
  directories.push(directory)
  const stateFile = join(directory, 'snapshot.json')
  const provider = new MemcodeMemoryProvider({
    client,
    binding: 'test-binding',
    pollMs: 1,
    ownerId: 'user_personal',
    stateFile,
  })
  return { calls, client, provider, stateFile }
}

test('advertises semantic recall without automatic transcript observation', () => {
  const { provider } = fixture()
  assert.deepEqual(provider.describe(), {
    protocolVersion: 2,
    key: 'memcode',
    label: 'Memcode',
    capabilities: {
      semanticQuery: true,
      sessionObservation: false,
      audioStreamObservation: false,
    },
  })
  assert.equal(provider.list('user_personal').length, 2)
})

test('persists an exact local snapshot only after Memcode completes the update', async () => {
  const { calls, provider, stateFile } = fixture()
  const [before] = provider.list('user_personal', { scope: 'user' })
  const result = await provider.apply('user_personal', [{
    document: 'user',
    expectedRevision: before.revision,
    append: '- Keep answers concise.',
  }], { sessionId: 'session-1', turnId: 'turn-1' })

  assert.equal(result.changed, 1)
  assert.match(result.documents.find(item => item.scope === 'user').content, /concise/)
  assert.equal(calls.ingest.length, 1)
  assert.match(calls.ingest[0].input.user_query, /Append: - Keep answers concise\./)
  assert.match(calls.ingest[0].options.idempotencyKey, /^qwen-audio:/)
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).owner_id, 'user_personal')
})

test('supports exact replace and delete while rejecting stale revisions', async () => {
  const { provider } = fixture()
  await provider.apply('user_personal', [{ document: 'memory', append: '- Old fact' }])
  const [current] = provider.list('user_personal', { scope: 'memory' })
  await provider.apply('user_personal', [{
    document: 'memory',
    expectedRevision: current.revision,
    edits: [{ old_text: 'Old fact', new_text: 'New fact' }],
  }])
  assert.match(provider.list('user_personal', { scope: 'memory' })[0].content, /New fact/)
  await assert.rejects(provider.apply('user_personal', [{
    document: 'memory',
    expectedRevision: current.revision,
    append: '- Stale write',
  }]), error => error.code === 'revision_conflict')
})

test('queries the credential-derived personal store and returns bounded evidence', async () => {
  const { calls, provider } = fixture()
  const result = await provider.query('user_personal', 'How should I answer?', {
    scope: 'user',
    limit: 3,
  })
  assert.deepEqual(calls.search, [{
    query: 'How should I answer?',
    top_k: 3,
    include_original_chunks: false,
  }])
  assert.equal(result.memories.length, 1)
  assert.equal(result.context, '- The user prefers concise answers.')
})

test('keeps the exact snapshot unchanged when remote ingest fails', async () => {
  const { client, provider } = fixture()
  const before = provider.list('user_personal', { scope: 'memory' })[0]
  client.ingestV2 = async () => { throw new Error('provider unavailable') }
  await assert.rejects(provider.apply('user_personal', [{
    document: 'memory',
    expectedRevision: before.revision,
    append: '- Must not persist',
  }]), /request_failed/)
  assert.deepEqual(provider.list('user_personal', { scope: 'memory' })[0], before)
  assert.deepEqual(provider.health(), {
    ok: false,
    configured: true,
    pending: true,
    error_code: 'request_failed',
  })
})

test('waits for terminal success, and serializes concurrent document updates', async () => {
  const { client, provider } = fixture()
  let polls = 0
  client.getIngestStatusV2 = async () => ({ status: ++polls === 1 ? 'processing' : 'completed' })
  await Promise.all(['one', 'two'].map(append => provider.apply('user_personal', [{ document: 'memory', append }])))
  assert.match(provider.list('user_personal')[1].content, /one\n\ntwo/)
  assert.equal(polls, 3)
})

test('a failed asynchronous ingest never commits the prepared snapshot', async () => {
  const { client, provider, stateFile } = fixture()
  client.getIngestStatusV2 = async () => ({ status: 'failed', error: 'secret upstream detail' })
  await assert.rejects(provider.apply('user_personal', [{ document: 'memory', append: 'new' }]), /ingest_failed/)
  assert.equal(provider.list('user_personal')[1].content, '# MEMORY')
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).pending, null)
})

test('recovers a pending job after restart without resubmitting or duplicating the edit', async () => {
  const { client, provider, stateFile, calls } = fixture()
  provider.timeoutMs = 5
  client.getIngestStatusV2 = async () => ({ status: 'processing' })
  const changes = [{ document: 'memory', append: 'remember once' }]
  await assert.rejects(provider.apply('user_personal', changes), /timeout/)
  assert.equal(provider.list('user_personal')[1].content, '# MEMORY')
  client.getIngestStatusV2 = async () => ({ status: 'completed' })
  const restored = new MemcodeMemoryProvider({ client, binding: 'test-binding', stateFile })
  await restored.apply('user_personal', changes)
  assert.equal(restored.list('user_personal')[1].content, '# MEMORY\n\nremember once')
  assert.equal(calls.ingest.length, 1)
})

test('an uncertain ingest receipt is retried with its persisted idempotency key', async () => {
  const { client, provider, calls, stateFile } = fixture()
  const ingest = client.ingestV2
  client.ingestV2 = async (input, options) => {
    await ingest(input, options)
    throw new Error('connection lost with private text')
  }
  const changes = [{ document: 'user', append: 'concise' }]
  await assert.rejects(provider.apply('user_personal', changes), /request_failed/)
  client.ingestV2 = ingest
  const restored = new MemcodeMemoryProvider({ client, binding: 'test-binding', stateFile })
  await restored.apply('user_personal', changes)
  assert.equal(calls.ingest[0].options.idempotencyKey, calls.ingest[1].options.idempotencyKey)
})

test('a new edit after undo gets a new idempotency key', async () => {
  const { provider, calls } = fixture()
  const change = [{ document: 'memory', append: 'fact' }]
  await provider.apply('user_personal', change)
  await provider.apply('user_personal', [{ document: 'memory', edits: [{ old_text: '\n\nfact', new_text: '' }] }])
  await provider.apply('user_personal', change)
  assert.notEqual(calls.ingest[0].options.idempotencyKey, calls.ingest[2].options.idempotencyKey)
})

test('preserves literal replacement text and empty documents across restart', async () => {
  const { provider, client, stateFile } = fixture()
  const literal = "$& $$ $` $'"
  await provider.apply('user_personal', [{ document: 'memory', edits: [{ old_text: '# MEMORY', new_text: literal }] }])
  assert.equal(provider.list('user_personal')[1].content, literal)
  await provider.apply('user_personal', [{ document: 'memory', edits: [{ old_text: literal, new_text: '' }] }])
  const restored = new MemcodeMemoryProvider({ client, binding: 'test-binding', stateFile })
  assert.equal(restored.list('user_personal')[1].content, '')
})

test('restores larger configured documents without truncation and rejects a smaller limit', async () => {
  const { client, stateFile } = fixture()
  const provider = new MemcodeMemoryProvider({ client, binding: 'test-binding', stateFile, maxChars: 12000 })
  await provider.apply('user_personal', [{ document: 'memory', append: 'x'.repeat(9000) }])
  const restored = new MemcodeMemoryProvider({ client, binding: 'test-binding', stateFile, maxChars: 12000 })
  assert.deepEqual(restored.list('user_personal'), provider.list('user_personal'))
  assert.throws(() => new MemcodeMemoryProvider({ client, binding: 'test-binding', stateFile }), /oversized/)
})

test('binds snapshots to endpoint and credential without persisting the credential', async () => {
  const { client, stateFile } = fixture()
  const key = 'test-private-credential'
  const binding = memcodeBinding('https://example.test', key)
  assert.equal(binding, memcodeBinding('https://example.test/', key))
  const provider = new MemcodeMemoryProvider({ client, binding, stateFile })
  await provider.apply('user_personal', [{ document: 'memory', append: 'private fact' }])
  assert.ok(!readFileSync(stateFile, 'utf8').includes(key))
  for (const other of [memcodeBinding('https://other.test', key), memcodeBinding('https://example.test', 'other-key')]) {
    assert.throws(() => new MemcodeMemoryProvider({ client, binding: other, stateFile }), /binding differs/)
  }
})

test('bounds a hung SDK request and hides raw errors', async () => {
  const { provider, client } = fixture()
  provider.timeoutMs = 5
  client.searchV2 = () => new Promise(() => {})
  await assert.rejects(provider.query('user_personal', 'query'), /timeout/)
  client.searchV2 = async () => { throw new Error('Authorization: private-token') }
  await assert.rejects(provider.query('user_personal', 'query'), error => error.code === 'request_failed' && !error.message.includes('private-token'))
})

test('fails closed across Gateway owners and leaves no remote call', async () => {
  const { calls, provider } = fixture()
  assert.throws(() => provider.list('user_other'), error => error.code === 'owner_mismatch')
  await assert.rejects(
    provider.query('user_other', 'private memory'),
    error => error.code === 'owner_mismatch',
  )
  assert.equal(calls.search.length, 0)
})

test('uses the published SDK request and response shapes without external network access', async t => {
  const { stateFile } = fixture()
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, ...options })
    const data = url.endsWith('/ingest') ? { job_id: 'job-sdk', status: 'processing' }
      : url.endsWith('/status') ? { job_id: 'job-sdk', status: 'completed' }
        : { memory_results: [{ domain: 'profile', content: 'Concise answers' }], original_chunks: [] }
    return new Response(JSON.stringify({ status: 'ok', data }), { status: 200 })
  })
  const provider = new MemcodeMemoryProvider({
    client: new MemcodeClient('https://memory.example.test', 'test-key'),
    binding: 'test-binding', stateFile,
  })
  await provider.apply('user_personal', [{ document: 'user', append: 'Concise answers' }])
  const result = await provider.query('user_personal', 'preferred style', { limit: 3.9 })
  assert.equal(result.context, '- Concise answers')
  assert.deepEqual(requests.map(item => new URL(item.url).pathname), [
    '/v2/memory/ingest', '/v2/memory/ingest/job-sdk/status', '/v2/memory/search',
  ])
  assert.equal(requests[0].headers.Authorization, 'Bearer test-key')
  assert.ok(requests[0].headers['Idempotency-Key'])
  const search = JSON.parse(requests[2].body)
  assert.equal(search.top_k, 3)
  assert.equal(search.user_id, undefined)
  assert.equal(search.mode, undefined)
})

test('launcher disables learning before importing Gateway and does not start a real service in this probe', () => {
  const { stateFile } = fixture()
  const launcher = new URL('./gateway.mjs', import.meta.url).href
  const source = `
    import { registerHooks } from 'node:module';
    registerHooks({ load(url, context, next) {
      if (url.endsWith('/server/src/app/gateway-application.mjs')) return {
        format: 'module', shortCircuit: true,
        source: 'export function createGatewayApplication({ memoryProvider }) { console.log(JSON.stringify({auto: process.env.QWEN_AUDIO_MEMORY_AUTO, preferences: process.env.QWEN_AUDIO_PREFERENCE_LEARNING, stateFile: memoryProvider.stateFile})); return { close() {} }; }'
      };
      return next(url, context);
    }});
    await import(${JSON.stringify(launcher)});
  `
  const env = { ...process.env, MEMCODE_API_KEY: 'test-key',
    MEMCODE_API_URL: 'https://memory.example.test', QWAUDIO_CONFIG_DIR: `${stateFile}-config`,
    QWEN_AUDIO_MEMORY_AUTO: 'on', QWEN_AUDIO_PREFERENCE_LEARNING: 'on' }
  delete env.NODE_TEST_CONTEXT
  delete env.NODE_OPTIONS
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source], { env, encoding: 'utf8', timeout: 10000 }))
  assert.equal(result.auto, 'off')
  assert.equal(result.preferences, 'off')
  assert.equal(result.stateFile, join(`${stateFile}-config`, 'memory', 'memcode', 'snapshot.json'))
})
