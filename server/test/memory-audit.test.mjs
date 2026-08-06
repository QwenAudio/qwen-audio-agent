import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoryAudit } from '../src/conversation/memory-audit.mjs'

test('appends one JSON line per event with private permissions', t => {
  const directory = mkdtempSync(join(tmpdir(), 'qwen-audio-agent-audit-'))
  t.after(() => rmSync(directory, { recursive: true }))
  const filePath = join(directory, 'state/memory-audit.jsonl')
  const audit = new MemoryAudit({ filePath, now: () => 1000 })

  assert.equal(audit.record({ op: 'write', ownerId: 'owner', content: '事实' }), true)
  assert.equal(audit.record({ op: 'skip', ownerId: 'owner', reason: 'duplicate' }), true)

  const lines = readFileSync(filePath, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(lines.length, 2)
  assert.equal(lines[0].op, 'write')
  assert.equal(lines[0].at, new Date(1000).toISOString())
  assert.equal(lines[1].reason, 'duplicate')
  assert.equal(statSync(filePath).mode & 0o777, 0o600)
  assert.deepEqual(audit.health(), {
    ok: true,
    configured: true,
    enabled: true,
    warning: null,
  })
})

test('stays silent without a file path', () => {
  const audit = new MemoryAudit()
  assert.equal(audit.record({ op: 'write' }), false)
  assert.equal(audit.health().configured, false)
})

test('disables itself after a write failure instead of throwing', () => {
  const warnings = []
  const audit = new MemoryAudit({
    // Writing under a path that cannot be created forces the failure branch.
    filePath: '/dev/null/impossible/memory-audit.jsonl',
    onWarning: warning => warnings.push(warning),
  })
  assert.equal(audit.record({ op: 'write' }), false)
  assert.equal(audit.record({ op: 'write' }), false)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0].message, /已停用审计/)
  assert.equal(audit.health().ok, false)
  assert.equal(audit.health().enabled, false)
})
