import { AsyncLocalStorage } from 'node:async_hooks'
import {
  appendFile,
  chmod,
  mkdir,
  rename,
  stat,
  unlink,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

export const LOG_SCHEMA = 'qwaudio.log/v1'
export const LOG_LEVELS = Object.freeze({
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: Number.POSITIVE_INFINITY,
})

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024
const DEFAULT_MAX_FILES = 5
const MAX_STRING_CHARS = 32_000
const MAX_COLLECTION_ITEMS = 100
const MAX_DEPTH = 8
const REDACTED = '[REDACTED]'
const SENSITIVE_KEY = /(?:api[_-]?key|authorization|cookie|credential|password|secret|token$)/i
const AUTH_VALUE = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi
const API_KEY_VALUE = /\bsk-[A-Za-z0-9_-]{8,}\b/g
const URL_SECRET_VALUE = /([?&](?:api[_-]?key|token|access_token|secret|password)=)[^&\s]+/gi
const contextStorage = new AsyncLocalStorage()

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

export function normalizeLogLevel(value, fallback = 'info') {
  const level = String(value || '').trim().toLowerCase()
  return Object.hasOwn(LOG_LEVELS, level) ? level : fallback
}

export function defaultLogDirectory(
  env = process.env,
  homeDirectory = homedir(),
) {
  if (env.QWEN_AUDIO_LOG_DIR) return resolve(env.QWEN_AUDIO_LOG_DIR)
  if (env.QWAUDIO_CONFIG_DIR) return resolve(env.QWAUDIO_CONFIG_DIR, 'logs')
  const base = env.XDG_CONFIG_HOME
    ? resolve(env.XDG_CONFIG_HOME)
    : resolve(homeDirectory, '.config')
  return resolve(base, 'qwaudio/logs')
}

function scrubString(value) {
  const scrubbed = String(value)
    .replace(AUTH_VALUE, match => `${match.split(/\s/, 1)[0]} ${REDACTED}`)
    .replace(API_KEY_VALUE, REDACTED)
    .replace(URL_SECRET_VALUE, `$1${REDACTED}`)
  return scrubbed.length > MAX_STRING_CHARS
    ? `${scrubbed.slice(0, MAX_STRING_CHARS)}…[truncated]`
    : scrubbed
}

function serializeError(error, seen, depth) {
  const result = {
    name: scrubString(error.name || 'Error'),
    message: scrubString(error.message || String(error)),
  }
  if (error.code !== undefined) result.code = scrubString(error.code)
  if (error.stack) result.stack = scrubString(error.stack)
  for (const key of Object.keys(error)) {
    if (key in result) continue
    result[key] = redactLogValue(error[key], key, seen, depth + 1)
  }
  return result
}

export function redactLogValue(
  value,
  key = '',
  seen = new WeakSet(),
  depth = 0,
) {
  if (SENSITIVE_KEY.test(key)) return REDACTED
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return scrubString(value)
  if (typeof value === 'bigint') return String(value)
  if (typeof value !== 'object') return value
  if (depth >= MAX_DEPTH) return '[MaxDepth]'
  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  if (value instanceof Error) return serializeError(value, seen, depth)
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_COLLECTION_ITEMS)
      .map(item => redactLogValue(item, '', seen, depth + 1))
    if (value.length > MAX_COLLECTION_ITEMS) items.push('[Truncated]')
    return items
  }
  return Object.fromEntries(Object.entries(value)
    .slice(0, MAX_COLLECTION_ITEMS)
    .map(([entryKey, entry]) => [
      entryKey,
      redactLogValue(entry, entryKey, seen, depth + 1),
    ]))
}

function safeEventName(value) {
  const event = String(value || '').trim()
  return event || 'log'
}

async function rotate(path, maxFiles) {
  const backups = Math.max(0, maxFiles - 1)
  if (backups === 0) {
    try {
      await unlink(path)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    return
  }
  try {
    await unlink(`${path}.${backups}`)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  for (let index = backups - 1; index >= 1; index -= 1) {
    try {
      await rename(`${path}.${index}`, `${path}.${index + 1}`)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  try {
    await rename(path, `${path}.1`)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

export class JsonLineFileSink {
  constructor({
    directory,
    fileName,
    maxBytes = DEFAULT_MAX_BYTES,
    maxFiles = DEFAULT_MAX_FILES,
    onError,
  }) {
    this.directory = resolve(directory)
    this.path = resolve(this.directory, fileName)
    this.maxBytes = Math.max(1024, maxBytes)
    this.maxFiles = Math.max(1, maxFiles)
    this.onError = onError
    this.failed = false
    this.initialized = false
    this.size = 0
    this.queue = []
    this.drainPromise = null
  }

  write(record) {
    this.queue.push(`${JSON.stringify(record)}\n`)
    this.startDrain()
  }

  async initialize() {
    if (this.initialized) return
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    try {
      this.size = (await stat(this.path)).size
      await chmod(this.path, 0o600)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      this.size = 0
    }
    this.initialized = true
  }

  startDrain() {
    if (this.drainPromise) return
    const operation = Promise.resolve().then(() => this.drain())
    const tracked = operation.finally(() => {
      if (this.drainPromise !== tracked) return
      this.drainPromise = null
      if (this.queue.length) this.startDrain()
    })
    this.drainPromise = tracked
  }

  async drain() {
    try {
      await this.initialize()
      while (this.queue.length) {
        const line = this.queue.shift()
        const bytes = Buffer.byteLength(line)
        if (this.size > 0 && this.size + bytes > this.maxBytes) {
          await rotate(this.path, this.maxFiles)
          this.size = 0
        }
        await appendFile(this.path, line, { encoding: 'utf8', mode: 0o600 })
        this.size += bytes
      }
      this.failed = false
    } catch (error) {
      this.queue.length = 0
      if (!this.failed) this.onError?.(error)
      this.failed = true
      this.initialized = false
    }
  }

  async flush() {
    while (this.queue.length || this.drainPromise) {
      this.startDrain()
      await this.drainPromise
    }
  }
}

function consoleLine(record) {
  const reserved = new Set([
    'schema', 'time', 'level', 'component', 'event', 'pid', 'message',
  ])
  const details = Object.fromEntries(
    Object.entries(record).filter(([key]) => !reserved.has(key)),
  )
  const suffix = Object.keys(details).length
    ? ` ${JSON.stringify(details)}`
    : ''
  return `${record.time} ${record.level.toUpperCase()} ${record.component} ${record.event}`
    + `${record.message ? `: ${record.message}` : ''}${suffix}\n`
}

export function runWithLogContext(context, callback) {
  return contextStorage.run(redactLogValue(context || {}), callback)
}

export function createLogger({
  component,
  fileName = `${component}.log`,
  env = process.env,
  directory = defaultLogDirectory(env),
  level = normalizeLogLevel(env.QWEN_AUDIO_LOG_LEVEL, 'info'),
  consoleEnabled,
  fileEnabled,
  stdout = process.stdout,
  stderr = process.stderr,
  base = {},
  sink,
} = {}) {
  consoleEnabled ??= env.QWEN_AUDIO_LOG_CONSOLE !== '0'
  fileEnabled ??= env.QWEN_AUDIO_LOG_FILE !== '0'
  const selectedLevel = normalizeLogLevel(level, 'info')
  const threshold = LOG_LEVELS[selectedLevel]
  let fileFailureReported = false
  const fileSink = sink || (fileEnabled
    ? new JsonLineFileSink({
        directory,
        fileName,
        maxBytes: boundedInteger(
          env.QWEN_AUDIO_LOG_MAX_BYTES,
          DEFAULT_MAX_BYTES,
          1024,
          1024 * 1024 * 1024,
        ),
        maxFiles: boundedInteger(
          env.QWEN_AUDIO_LOG_MAX_FILES,
          DEFAULT_MAX_FILES,
          1,
          100,
        ),
        onError: error => {
          if (fileFailureReported || !consoleEnabled) return
          fileFailureReported = true
          stderr.write(`qwen-audio-agent 日志写入失败：${scrubString(error.message)}\n`)
        },
      })
    : null)
  const sanitizedBase = redactLogValue(base || {})

  const emit = (entryLevel, event, fields = {}, message = '') => {
    if (LOG_LEVELS[entryLevel] < threshold) return
    if (typeof fields === 'string') {
      message = fields
      fields = {}
    }
    if (fields instanceof Error) fields = { error: fields }
    const record = {
      ...sanitizedBase,
      ...redactLogValue(contextStorage.getStore() || {}),
      ...redactLogValue(fields || {}),
      schema: LOG_SCHEMA,
      time: new Date().toISOString(),
      level: entryLevel,
      component: String(component || 'app'),
      event: safeEventName(event),
      pid: process.pid,
      ...(message ? { message: scrubString(message) } : {}),
    }
    fileSink?.write(record)
    if (consoleEnabled) {
      const output = LOG_LEVELS[entryLevel] >= LOG_LEVELS.warn ? stderr : stdout
      try {
        output.write(consoleLine(record))
      } catch {
        // Logging must never interrupt the application.
      }
    }
  }

  const logger = {
    level: selectedLevel,
    directory,
    filePath: fileSink?.path || null,
    trace: (event, fields, message) => emit('trace', event, fields, message),
    debug: (event, fields, message) => emit('debug', event, fields, message),
    info: (event, fields, message) => emit('info', event, fields, message),
    warn: (event, fields, message) => emit('warn', event, fields, message),
    error: (event, fields, message) => emit('error', event, fields, message),
    fatal: (event, fields, message) => emit('fatal', event, fields, message),
    flush: () => fileSink?.flush?.() || Promise.resolve(),
    child: context => createLogger({
      component,
      fileName,
      env,
      directory,
      level: selectedLevel,
      consoleEnabled,
      fileEnabled: Boolean(fileSink),
      stdout,
      stderr,
      base: { ...sanitizedBase, ...redactLogValue(context || {}) },
      sink: fileSink,
    }),
  }
  return Object.freeze(logger)
}
