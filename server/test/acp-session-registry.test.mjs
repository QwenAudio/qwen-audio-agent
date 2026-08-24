import assert from 'node:assert/strict'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AcpSessionRegistry } from '../src/agent/acp-session-registry.mjs'

test('preserves legacy coordinator records while persisting project directories', () => {
  const directory = mkdtempSync(join(tmpdir(), 'qwaudio-acp-registry-'))
  const filePath = join(directory, 'acp-sessions.json')
  try {
    writeFileSync(filePath, JSON.stringify({
      version: 1,
      coordinators: {
        'qoder:owner:backend': {
          sessionId: 'coordinator',
          cwd: '/coordinator',
          updatedAt: 1,
        },
      },
    }))
    const registry = new AcpSessionRegistry({ filePath })
    assert.equal(
      registry.get('qoder:owner:backend').sessionId,
      'coordinator',
    )
    registry.setProject('qoder:project-session', {
      sessionId: 'project-session',
      cwd: '/project',
      title: 'Project',
    })

    const reloaded = new AcpSessionRegistry({ filePath })
    assert.deepEqual(
      reloaded.getProject('qoder:project-session'),
      JSON.parse(readFileSync(filePath, 'utf8')).projects[
        'qoder:project-session'
      ],
    )
    assert.equal(
      reloaded.get('qoder:owner:backend').sessionId,
      'coordinator',
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('persists bounded cancellation reconciliation until it is acknowledged', () => {
  const directory = mkdtempSync(join(tmpdir(), 'qwaudio-acp-reconcile-'))
  const filePath = join(directory, 'acp-sessions.json')
  const key = 'qoder:owner:backend'
  try {
    const registry = new AcpSessionRegistry({ filePath })
    for (let index = 1; index <= 21; index += 1) {
      registry.appendReconciliation(key, {
        kind: 'coordination_request_terminated',
        request_id: `work-${index}`,
        outcome: 'cancelled',
        confirmed_at: `time-${index}`,
      })
    }
    registry.appendReconciliation(key, {
      kind: 'coordination_request_terminated',
      request_id: 'work-21',
      outcome: 'cancelled',
      confirmed_at: 'updated-time',
    })

    const reloaded = new AcpSessionRegistry({ filePath })
    const facts = reloaded.reconciliationsFor(key)
    assert.equal(facts.length, 20)
    assert.equal(facts[0].request_id, 'work-2')
    assert.equal(facts.at(-1).confirmed_at, 'updated-time')

    reloaded.acknowledgeReconciliations(key, [facts[0]])
    assert.equal(reloaded.reconciliationsFor(key).length, 19)
    reloaded.delete(key)
    assert.deepEqual(reloaded.reconciliationsFor(key), [])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('quarantines a corrupt Session index before accepting new state', () => {
  const directory = mkdtempSync(join(tmpdir(), 'qwaudio-acp-corrupt-'))
  const filePath = join(directory, 'acp-sessions.json')
  const warnings = []
  try {
    writeFileSync(filePath, '{not-json')
    const registry = new AcpSessionRegistry({
      filePath,
      onWarning: warning => warnings.push(warning),
    })
    assert.equal(registry.get('missing'), null)
    assert.equal(warnings.length, 1)
    assert.ok(warnings[0].quarantinePath)
    assert.equal(existsSync(warnings[0].quarantinePath), true)
    assert.equal(registry.health().ok, false)

    registry.set('qoder:owner:backend', {
      sessionId: 'new-session',
      cwd: '/work',
      contractVersion: 1,
    })
    const saved = JSON.parse(readFileSync(filePath, 'utf8')).coordinators[
      'qoder:owner:backend'
    ]
    assert.equal(saved.sessionId, 'new-session')
    assert.equal(saved.contractVersion, 1)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('quarantines an unsupported Session index version', () => {
  const directory = mkdtempSync(join(tmpdir(), 'qwaudio-acp-version-'))
  const filePath = join(directory, 'acp-sessions.json')
  try {
    writeFileSync(filePath, JSON.stringify({
      version: 999,
      coordinators: {},
      projects: {},
    }))
    const registry = new AcpSessionRegistry({ filePath, onWarning: () => {} })
    assert.equal(registry.get('missing'), null)
    assert.equal(registry.health().ok, false)
    assert.equal(existsSync(filePath), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
