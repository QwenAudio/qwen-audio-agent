import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { MemcodeMemoryProvider } from './provider.mjs'

function fixture() {
  const calls = { ingest: [], search: [] }
  const client = {
    async ingestV2(input, options) {
      calls.ingest.push({ input, options })
      return { job_id: 'job-1', status: 'processing' }
    },
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
  const stateFile = join(directory, 'snapshot.json')
  const provider = new MemcodeMemoryProvider({
    client,
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

test('persists an exact local snapshot only after Memcode accepts the update', async () => {
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
    mode: 'memories',
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
  }]), /provider unavailable/)
  assert.deepEqual(provider.list('user_personal', { scope: 'memory' })[0], before)
  assert.deepEqual(provider.health(), {
    ok: false,
    configured: true,
    error_code: 'Error',
  })
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
