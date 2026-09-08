import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, rm, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { LOG_SCHEMA } from '../../shared/logger.mjs'
import { createSessionHeader } from '../../shared/session-events.mjs'
import { collectDiagnostics, formatDiagnostics, readTurnTimeline } from '../src/diagnostics.mjs'
import { inspectSessionJournals } from '../../server/src/session/session-journal-inspection.mjs'

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'qwaudio-diagnostics-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

const health = {
  protocolVersion: '6.0.0', backend: { enabled: false },
  voiceClients: { realtime: { connected: 0, unavailable: 0 } },
  frontendMcp: { ok: true, initialized: true },
}
const response = value => ({ ok: true, json: async () => value })

test('diagnoses missing configuration without creating files or calling a model', async t => {
  const directory = await fixture(t)
  const report = await collectDiagnostics({
    environment: { configDirectory: directory, configPath: join(directory, 'config.env') },
    options: { url: 'http://127.0.0.1:3101', accessToken: 'private-token' }, env: {},
    fetchImpl: async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:3101/api/health')
      assert.equal(options.headers.Authorization, 'Bearer private-token')
      assert.equal(options.redirect, 'error')
      return response(health)
    },
  })
  assert.equal(report.ok, false)
  assert.equal(report.checks.find(check => check.id === 'realtime.configuration').status, 'error')
  assert.equal(report.checks.find(check => check.id === 'realtime.connection').status, 'warning')
  assert.equal(report.checks.find(check => check.id === 'backend').status, 'skipped')
  assert.doesNotMatch(JSON.stringify(report), /private-token/)
  assert.deepEqual(await readdir(directory), [])
})

test('a configured key does not imply Realtime readiness; raw errors and secrets stay private', async t => {
  const directory = await fixture(t)
  const report = await collectDiagnostics({
    environment: { configDirectory: directory, configPath: join(directory, 'config.env') },
    options: { url: 'http://127.0.0.1:3101' },
    env: { DASHSCOPE_API_KEY: 'sk-private-key', QWEN_AUDIO_FRONTEND_MCP_CONFIG: join(directory, 'missing-secret.json') },
    fetchImpl: async () => response({ ...health,
      voiceClients: { realtime: { unavailable: 1, error: 'private-provider-response' } },
      frontendMcp: { ok: false, error: 'private-mcp-response' },
    }),
  })
  assert.equal(report.checks.find(check => check.id === 'realtime.configuration').status, 'ok')
  assert.equal(report.checks.find(check => check.id === 'realtime.connection').status, 'error')
  assert.equal(report.checks.find(check => check.id === 'mcp.configuration').status, 'error')
  assert.doesNotMatch(JSON.stringify(report), /sk-private|private-provider|private-mcp|missing-secret/)
})

test('remote checks do not inspect local config or present local logs as remote evidence', async () => {
  for (const status of [401, 403, 500]) {
    const report = await collectDiagnostics({
      environment: {}, options: { url: 'https://gateway.example.test', urlSpecified: true, turnId: 'turn-1' },
      env: {}, fetchImpl: async () => ({ ok: false, status }),
    })
    assert.equal(report.ok, false)
    assert.deepEqual(report.checks.map(check => check.id), ['gateway', 'timeline'])
    assert.equal(report.checks[0].details.httpStatus, status)
    assert.equal(report.timeline, undefined)
  }
  const report = await collectDiagnostics({
    environment: {}, options: { url: 'https://gateway.example.test', urlSpecified: true },
    fetchImpl: async () => { throw new Error('sensitive network error') },
  })
  assert.equal(report.ok, false)
  assert.doesNotMatch(formatDiagnostics(report), /sensitive/)
})

test('journal inspection reports committed corruption and recoverable tails without modifying them', async t => {
  const directory = await fixture(t)
  const valid = `${JSON.stringify(createSessionHeader({ sessionId: 's1' }))}\n`
  const contents = [valid, `${valid}{"unfinished":`, `${valid}{bad}\n`, valid.repeat(30)]
  for (const [index, content] of contents.entries()) {
    const subdir = join(directory, String(index))
    await mkdir(subdir)
    await writeFile(join(subdir, 'session.jsonl'), content)
  }
  const report = await inspectSessionJournals(directory, { maxFileBytes: 1_024 })
  assert.deepEqual([report.files, report.checked, report.damaged, report.tornTails, report.skipped], [4, 2, 1, 1, 1])
  for (const [index, content] of contents.entries()) {
    assert.equal(await readFile(join(directory, String(index), 'session.jsonl'), 'utf8'), content)
  }
  assert.equal((await inspectSessionJournals(directory, { maxFiles: 1 })).partial, true)
  // A path that is not a directory must not produce a false healthy report.
  assert.equal((await inspectSessionJournals(join(directory, '0', 'session.jsonl'))).unreadable, 1)
})

test('turn timelines join rotated logs by exact turn ID and expose only identity and timing', async t => {
  const directory = await fixture(t)
  const record = { schema: LOG_SCHEMA, turnId: 'turn-1', level: 'info', event: 'realtime.tool_call.received' }
  await writeFile(join(directory, 'gateway.log.1'), `${JSON.stringify({ ...record, time: '2026-09-08T00:00:00.000Z', taskId: 'task-1', arguments: { secret: 'private-secret' } })}\n`)
  await writeFile(join(directory, 'gateway.log'), [
    { ...record, time: '2026-09-08T00:00:00.200Z', event: 'task.completed', text: 'private-conversation' },
    { ...record, time: '2026-09-08T00:00:00.300Z', turnId: 'other-turn' },
    { ...record, time: '2026-09-08T00:00:00.400Z', schema: 'other-schema' },
  ].map(JSON.stringify).join('\n') + '\n{"partial":')
  const timeline = await readTurnTimeline(directory, 'turn-1')
  assert.deepEqual(timeline.events.map(event => event.offsetMs), [0, 200])
  assert.doesNotMatch(JSON.stringify(timeline), /private-|arguments|text/)
  assert.equal((await readTurnTimeline(directory, 'turn-1', { maxFileBytes: 100 })).partial, true)
  assert.deepEqual((await readTurnTimeline(directory, 'nonexistent')).events, [])
  assert.equal((await readTurnTimeline(join(directory, 'missing'), 'turn-1')).partial, true)
})
