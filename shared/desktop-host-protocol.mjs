import { StringDecoder } from 'node:string_decoder'
import { z } from 'zod'

export const DESKTOP_HOST_PROTOCOL_VERSION = 1
export const MAX_DESKTOP_HOST_LINE_BYTES = 1024 * 1024

export const WINDOWS_RUNTIME_STATES = Object.freeze([
  'checking',
  'setup-required',
  'starting',
  'ready',
  'recovering',
  'external',
  'error',
  'stopping',
])

export const DESKTOP_HOST_METHODS = Object.freeze([
  'runtime.status',
  'settings.read',
  'settings.write',
  'backends.inspect',
  'gateway.start',
  'gateway.restart',
  'gateway.stop',
  'logs.tail',
  'host.shutdown',
])

export const DESKTOP_HOST_EVENTS = Object.freeze([
  'hello',
  'gateway.ready',
  'gateway.status',
])

const RequestIdSchema = z.string().min(1).max(128)
const JsonPrimitiveSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
])
const JsonValueSchema = z.lazy(() => z.union([
  JsonPrimitiveSchema,
  z.array(JsonValueSchema),
  z.record(z.string(), JsonValueSchema),
]))
const ParamsSchema = z.record(z.string(), JsonValueSchema)

export const DesktopHostRequestSchema = z.object({
  id: RequestIdSchema,
  method: z.enum(DESKTOP_HOST_METHODS),
  params: ParamsSchema,
}).strict()

export const DesktopHostSuccessResponseSchema = z.object({
  id: RequestIdSchema,
  ok: z.literal(true),
  result: JsonValueSchema,
}).strict()

export const DesktopHostErrorResponseSchema = z.object({
  id: RequestIdSchema,
  ok: z.literal(false),
  error: z.object({
    code: z.string().min(1).max(128),
    message: z.string().min(1).max(4096),
    details: JsonValueSchema.optional(),
  }).strict(),
}).strict()

export const DesktopHostResponseSchema = z.discriminatedUnion('ok', [
  DesktopHostSuccessResponseSchema,
  DesktopHostErrorResponseSchema,
])

export const DesktopHostEventSchema = z.object({
  event: z.enum(DESKTOP_HOST_EVENTS),
  data: z.record(z.string(), JsonValueSchema),
}).strict()

export const DesktopHostMessageSchema = z.union([
  DesktopHostRequestSchema,
  DesktopHostResponseSchema,
  DesktopHostEventSchema,
])

export function parseDesktopHostMessage(value) {
  return DesktopHostMessageSchema.parse(value)
}

export function encodeDesktopHostMessage(message) {
  const line = JSON.stringify(parseDesktopHostMessage(message))
  const bytes = Buffer.byteLength(line, 'utf8')
  if (bytes > MAX_DESKTOP_HOST_LINE_BYTES) {
    throw new DesktopHostProtocolError(
      'line_too_large',
      `Desktop host message exceeds ${MAX_DESKTOP_HOST_LINE_BYTES} bytes`,
    )
  }
  return `${line}\n`
}

export class DesktopHostProtocolError extends Error {
  constructor(code, message, options) {
    super(message, options)
    this.name = 'DesktopHostProtocolError'
    this.code = code
  }
}

function lineTooLargeError(maxLineBytes) {
  return new DesktopHostProtocolError(
    'line_too_large',
    `Desktop host message exceeds ${maxLineBytes} bytes`,
  )
}

export function createDesktopHostJsonLineDecoder({
  onMessage,
  onError = () => {},
  maxLineBytes = MAX_DESKTOP_HOST_LINE_BYTES,
} = {}) {
  if (typeof onMessage !== 'function') {
    throw new TypeError('onMessage must be a function')
  }
  if (typeof onError !== 'function') {
    throw new TypeError('onError must be a function')
  }
  if (
    !Number.isSafeInteger(maxLineBytes)
    || maxLineBytes < 1
    || maxLineBytes > MAX_DESKTOP_HOST_LINE_BYTES
  ) {
    throw new RangeError(
      `maxLineBytes must be between 1 and ${MAX_DESKTOP_HOST_LINE_BYTES}`,
    )
  }
  const decoder = new StringDecoder('utf8')
  let buffered = ''
  let discardingOversizedLine = false
  let ended = false

  function consumeLines(text = '') {
    if (discardingOversizedLine) {
      const discardedLineEnd = text.indexOf('\n')
      if (discardedLineEnd < 0) return
      discardingOversizedLine = false
      text = text.slice(discardedLineEnd + 1)
    }
    buffered += text
    let newlineIndex = buffered.indexOf('\n')
    while (newlineIndex >= 0) {
      const line = buffered.slice(0, newlineIndex).replace(/\r$/, '')
      buffered = buffered.slice(newlineIndex + 1)
      if (Buffer.byteLength(line, 'utf8') > maxLineBytes) {
        onError(lineTooLargeError(maxLineBytes))
      } else if (line.length > 0) {
        let value
        try {
          value = JSON.parse(line)
          onMessage(parseDesktopHostMessage(value))
        } catch (error) {
          onError(error, { value })
        }
      }
      newlineIndex = buffered.indexOf('\n')
    }
    if (Buffer.byteLength(buffered, 'utf8') > maxLineBytes) {
      buffered = ''
      discardingOversizedLine = true
      onError(lineTooLargeError(maxLineBytes))
    }
  }

  return {
    push(chunk) {
      if (ended) throw new DesktopHostProtocolError(
        'decoder_ended',
        'Desktop host decoder has already ended',
      )
      consumeLines(decoder.write(chunk))
    },
    end(chunk) {
      if (ended) return
      ended = true
      consumeLines(chunk === undefined ? decoder.end() : decoder.end(chunk))
      if (buffered.length > 0 && !discardingOversizedLine) {
        onError(new DesktopHostProtocolError(
          'unterminated_line',
          'Desktop host stream ended with an unterminated line',
        ))
        buffered = ''
      }
    },
  }
}

const SECRET_KEY_PARTS = [
  'token',
  'secret',
  'password',
  'authorization',
  'apikey',
  'accesskey',
]
const SECRET_ASSIGNMENT_PATTERN = /\b((?:dashscope[_-]?)?api[_-]?key|access[_-]?key|refresh[_-]?token|auth(?:orization)?|password|secret|token)\s*[:=]\s*([^\s,;]+)/gi
const BEARER_PATTERN = /\bBearer\s+[^\s,;"']+/gi

function isSecretKey(key) {
  const normalized = String(key).replace(/[^a-z0-9]/gi, '').toLowerCase()
  return SECRET_KEY_PARTS.some(part => normalized.includes(part))
}

function redactString(value) {
  return value
    .replace(BEARER_PATTERN, 'Bearer [REDACTED]')
    .replace(SECRET_ASSIGNMENT_PATTERN, '$1=[REDACTED]')
}

export function redactDesktopHostValue(value) {
  function visit(current, ancestors) {
    if (typeof current === 'string') return redactString(current)
    if (current === null || typeof current !== 'object') return current
    if (ancestors.has(current)) return '[Circular]'

    ancestors.add(current)
    let result
    if (Array.isArray(current)) {
      result = current.map(item => visit(item, ancestors))
    } else {
      result = Object.fromEntries(Object.entries(current).map(([key, item]) => [
        key,
        isSecretKey(key) ? '[REDACTED]' : visit(item, ancestors),
      ]))
    }
    ancestors.delete(current)
    return result
  }

  return visit(value, new WeakSet())
}
