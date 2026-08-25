import assert from 'node:assert/strict'
import {
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import { FileKnowledgeStore } from '../src/providers/knowledge/file-knowledge-store.mjs'
import { assertKnowledgeStore } from '../src/frontend/knowledge/knowledge-store.mjs'

function fixture(options = {}) {
  const directory = mkdtempSync(resolve(tmpdir(), 'qwaudio-knowledge-'))
  return new FileKnowledgeStore({ directory, ...options })
}

function document(id, text = 'Knowledge text') {
  return {
    id,
    title: `${id}.md`,
    mimeType: 'text/markdown',
    revision: `revision-${text}`,
    source: { kind: 'upload', label: `${id}.md` },
    chunks: [{ text }],
  }
}

test('validates the knowledge store port', () => {
  assert.throws(
    () => assertKnowledgeStore({ describe: () => ({ key: 'invalid' }) }),
    /putDocument/,
  )
  const invalid = fixture()
  invalid.describe = () => ({ key: 'INVALID', label: 'Invalid' })
  assert.throws(() => assertKnowledgeStore(invalid), /invalid identity/)
  assert.equal(assertKnowledgeStore(fixture()).describe().key, 'local-files')
})

test('stores owner-isolated documents in private hashed files', () => {
  let timestamp = 100
  const store = fixture({ now: () => timestamp++ })
  const first = store.putDocument('owner@example.com', document('doc_first'))
  store.putDocument('other-owner', document('doc_other'))

  assert.equal(first.chunkCount, 1)
  assert.equal(store.listDocuments('owner@example.com').length, 1)
  assert.equal(store.getDocument('owner@example.com', 'doc_first').chunks[0].text, 'Knowledge text')
  assert.equal(store.getDocument('other-owner', 'doc_first'), null)
  assert.doesNotMatch(store.pathFor('owner@example.com'), /owner@example\.com/u)
  if (process.platform !== 'win32') {
    assert.equal(statSync(store.pathFor('owner@example.com')).mode & 0o777, 0o600)
  }

  timestamp = 200
  const replaced = store.putDocument(
    'owner@example.com',
    document('doc_first', 'Updated text'),
  )
  assert.equal(replaced.createdAt, first.createdAt)
  assert.equal(replaced.updatedAt, 200)
  assert.equal(store.removeDocument('owner@example.com', 'doc_first'), true)
  assert.equal(store.removeDocument('owner@example.com', 'doc_first'), false)
})

test('serializes read-modify-write operations across store instances', () => {
  const first = fixture()
  const second = new FileKnowledgeStore({ directory: first.directory })

  first.putDocument('shared-owner', document('doc_one'))
  second.putDocument('shared-owner', document('doc_two'))

  assert.deepEqual(
    first.listDocuments('shared-owner').map(item => item.id).sort(),
    ['doc_one', 'doc_two'],
  )
})

test('fails closed instead of overwriting corrupt persisted data', () => {
  const warnings = []
  const store = fixture({ onWarning: warning => warnings.push(warning) })
  const path = store.pathFor('owner')
  store.putDocument('owner', document('doc_valid'))
  writeFileSync(path, '{"version":1,"documents":[{"id":"broken"}]}\n')

  assert.throws(
    () => store.putDocument('owner', document('doc_new')),
    error => error.code === 'knowledge_store_invalid',
  )
  assert.match(readFileSync(path, 'utf8'), /"broken"/u)
  assert.equal(warnings.length, 1)
  assert.equal(store.health().ok, false)
})
