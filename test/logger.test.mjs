import assert from 'node:assert/strict'
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import {
  LOG_SCHEMA,
  createLogger,
  redactLogValue,
  runWithLogContext,
} from '../shared/logger.mjs'

function temporaryDirectory(t) {
  const directory = mkdtempSync(resolve(tmpdir(), 'qwaudio-logger-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

function records(path) {
  return readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse)
}

test('writes standard structured JSONL with inherited correlation context', t => {
  const directory = temporaryDirectory(t)
  const logger = createLogger({
    component: 'gateway',
    directory,
    consoleEnabled: false,
  })

  runWithLogContext({ sessionId: 'session-1', turnId: 'turn-2' }, () => {
    logger.child({ provider: 'dashscope' }).info(
      'realtime.connected',
      { durationMs: 42 },
      'Realtime ready',
    )
  })

  const [entry] = records(resolve(directory, 'gateway.log'))
  assert.equal(entry.schema, LOG_SCHEMA)
  assert.equal(entry.level, 'info')
  assert.equal(entry.component, 'gateway')
  assert.equal(entry.event, 'realtime.connected')
  assert.equal(entry.sessionId, 'session-1')
  assert.equal(entry.turnId, 'turn-2')
  assert.equal(entry.provider, 'dashscope')
  assert.equal(entry.durationMs, 42)
  assert.equal(entry.message, 'Realtime ready')
  assert.match(entry.time, /^\d{4}-\d{2}-\d{2}T/)
  if (process.platform !== 'win32') {
    assert.equal(statSync(resolve(directory, 'gateway.log')).mode & 0o777, 0o600)
  }
})

test('redacts secrets recursively from fields, errors and free text', t => {
  const directory = temporaryDirectory(t)
  const logger = createLogger({
    component: 'desktop',
    directory,
    consoleEnabled: false,
  })
  const error = new Error('request used Bearer abc.def.ghi and sk-secretvalue123')
  error.authorization = 'Bearer should-not-leak'

  logger.error('request.failed', {
    apiKey: 'sk-privatevalue123',
    nested: {
      accessToken: 'token-value',
      inputTokens: 123,
      safe: 'https://example.com/callback?token=hidden-value&ok=1',
    },
    error,
  })

  const content = readFileSync(resolve(directory, 'desktop.log'), 'utf8')
  assert.doesNotMatch(content, /privatevalue|token-value|abc\.def|secretvalue/)
  const [entry] = content.trim().split('\n').map(JSON.parse)
  assert.equal(entry.apiKey, '[REDACTED]')
  assert.equal(entry.nested.accessToken, '[REDACTED]')
  assert.equal(entry.nested.inputTokens, 123)
  assert.equal(
    entry.nested.safe,
    'https://example.com/callback?token=[REDACTED]&ok=1',
  )
  assert.equal(entry.error.authorization, '[REDACTED]')
})

test('honors log levels and rotates bounded files', t => {
  const directory = temporaryDirectory(t)
  const logger = createLogger({
    component: 'gateway',
    directory,
    level: 'warn',
    consoleEnabled: false,
    env: {
      QWEN_AUDIO_LOG_MAX_BYTES: '1024',
      QWEN_AUDIO_LOG_MAX_FILES: '3',
    },
  })

  logger.info('ignored', { value: 'not written' })
  for (let index = 0; index < 30; index += 1) {
    logger.warn('rotation.test', { index, payload: 'x'.repeat(160) })
  }

  const files = readdirSync(directory).sort()
  assert.deepEqual(files, ['gateway.log', 'gateway.log.1', 'gateway.log.2'])
  assert.equal(
    files.flatMap(file => records(resolve(directory, file)))
      .some(entry => entry.event === 'ignored'),
    false,
  )
})

test('redaction tolerates circular diagnostic objects', () => {
  const value = { name: 'root' }
  value.self = value
  assert.deepEqual(redactLogValue(value), {
    name: 'root',
    self: '[Circular]',
  })
})

test('diagnostic fields cannot replace the standard log envelope', t => {
  const directory = temporaryDirectory(t)
  const logger = createLogger({
    component: 'gateway',
    directory,
    consoleEnabled: false,
  })

  logger.info('gateway.ready', {
    schema: 'untrusted',
    level: 'fatal',
    component: 'other',
    event: 'other',
    pid: -1,
  })

  const [entry] = records(resolve(directory, 'gateway.log'))
  assert.equal(entry.schema, LOG_SCHEMA)
  assert.equal(entry.level, 'info')
  assert.equal(entry.component, 'gateway')
  assert.equal(entry.event, 'gateway.ready')
  assert.equal(entry.pid, process.pid)
})
