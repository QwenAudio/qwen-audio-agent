import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const API_KEY = /^[a-z][a-z0-9_-]{0,39}$/u
const OPERATION_ID = /^[a-zA-Z0-9_.:-]{1,128}$/u
const ENV_REFERENCE = /^\$\{([A-Z_][A-Z0-9_]*)\}$/u
const MAX_APIS = 8
const MAX_OPERATIONS_PER_API = 32

function clean(value, maxChars = 1_000) {
  return [...String(value || '').trim()].slice(0, maxChars).join('')
}

function boundedInteger(value, fallback, minimum, maximum) {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Frontend OpenAPI policy value must be ${minimum}-${maximum}.`)
  }
  return parsed
}

function resolveSecret(value, env) {
  const source = clean(value, 8_192)
  const match = ENV_REFERENCE.exec(source)
  if (!match) return source
  const resolved = clean(env[match[1]], 8_192)
  if (!resolved) {
    throw new Error(`Frontend OpenAPI environment variable is missing: ${match[1]}`)
  }
  return resolved
}

function normalizedHeaders(value, env) {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Frontend OpenAPI headers must be an object.')
  }
  const entries = Object.entries(value)
  if (entries.length > 16) throw new Error('Frontend OpenAPI has too many headers.')
  return Object.fromEntries(entries.map(([name, content]) => {
    const header = clean(name, 80).toLowerCase()
    const resolved = resolveSecret(content, env)
    if (!/^[a-z0-9-]+$/u.test(header) || /[\r\n]/u.test(resolved)) {
      throw new Error('Frontend OpenAPI contains an invalid header.')
    }
    if (['host', 'content-length', 'connection'].includes(header)) {
      throw new Error(`Frontend OpenAPI cannot configure the ${header} header.`)
    }
    return [header, resolved]
  }).filter(([, content]) => Boolean(content)))
}

function normalizedBaseUrl(value, { hasHeaders }) {
  const source = clean(value, 2_048)
  if (!source) return ''
  let url
  try {
    url = new URL(source)
  } catch {
    throw new Error('Frontend OpenAPI base URL is invalid.')
  }
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
  if (
    url.username
    || url.password
    || url.hash
    || url.search
    || !['http:', 'https:'].includes(url.protocol)
    || (url.protocol !== 'https:' && (!loopback || hasHeaders))
  ) {
    throw new Error(
      'Remote Frontend OpenAPI requires HTTPS; local HTTP cannot carry headers.',
    )
  }
  return url.toString()
}

function normalizedPolicy(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Frontend OpenAPI operation policy must be an object.')
  }
  const enabled = value.enabled === true
  if ('readOnly' in value || 'approval' in value) {
    throw new Error(
      'Frontend OpenAPI configuration does not define readOnly or approval; enforce confirmation in the API service.',
    )
  }
  return {
    enabled,
    timeoutMs: boundedInteger(value.timeoutMs, 8_000, 100, 30_000),
    maxResultBytes: boundedInteger(
      value.maxResultBytes,
      32 * 1024,
      1_024,
      64 * 1024,
    ),
    maxCallsPerTurn: boundedInteger(value.maxCallsPerTurn, 2, 1, 4),
    ...(clean(value.description, 1_200)
      ? { description: clean(value.description, 1_200) }
      : {}),
  }
}

function normalizedApi(key, value, { env, baseDirectory }) {
  if (!API_KEY.test(key)) throw new Error(`Invalid Frontend OpenAPI key: ${key}`)
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Frontend OpenAPI ${key} must be an object.`)
  }
  const document = clean(value.document, 2_048)
  if (!document) {
    throw new Error(`Frontend OpenAPI ${key} requires a local document path.`)
  }
  if (/^(?:[a-z][a-z0-9+.-]*:\/\/|file:)/iu.test(document)) {
    throw new Error('Frontend OpenAPI documents must be local files.')
  }
  const headers = normalizedHeaders(value.headers, env)
  const operations = value.operations === undefined ? {} : value.operations
  if (!operations || typeof operations !== 'object' || Array.isArray(operations)) {
    throw new Error(`Frontend OpenAPI ${key} operations must be an object.`)
  }
  const entries = Object.entries(operations)
  if (entries.length > MAX_OPERATIONS_PER_API) {
    throw new Error(`Frontend OpenAPI ${key} has too many operation policies.`)
  }
  return {
    key,
    enabled: value.enabled === true,
    documentPath: resolve(baseDirectory, document),
    baseUrl: normalizedBaseUrl(value.baseUrl, {
      hasHeaders: Object.keys(headers).length > 0,
    }),
    headers,
    operations: Object.fromEntries(entries.map(([operationId, policy]) => {
      if (!OPERATION_ID.test(operationId)) {
        throw new Error(`Invalid Frontend OpenAPI operationId: ${operationId}`)
      }
      return [operationId, normalizedPolicy(policy)]
    })),
  }
}

export function normalizeFrontendOpenApiConfiguration(value, {
  env = process.env,
  baseDirectory = process.cwd(),
} = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Frontend OpenAPI configuration must be an object.')
  }
  if (value.version !== 1) {
    throw new Error('Frontend OpenAPI configuration version must be 1.')
  }
  const apis = value.apis === undefined ? {} : value.apis
  if (!apis || typeof apis !== 'object' || Array.isArray(apis)) {
    throw new Error('Frontend OpenAPI apis must be an object.')
  }
  const entries = Object.entries(apis)
  if (entries.length > MAX_APIS) {
    throw new Error(`Frontend OpenAPI supports at most ${MAX_APIS} APIs.`)
  }
  return {
    version: 1,
    apis: entries.map(([key, api]) => normalizedApi(key, api, {
      env,
      baseDirectory,
    })),
  }
}

export function loadFrontendOpenApiConfiguration({
  filePath = process.env.QWEN_AUDIO_FRONTEND_OPENAPI_CONFIG,
  env = process.env,
} = {}) {
  const configuredPath = clean(filePath, 2_048)
  if (!configuredPath) return { version: 1, apis: [] }
  const path = resolve(configuredPath)
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    const failure = new Error(
      `Unable to read Frontend OpenAPI configuration: ${error.message}`,
    )
    failure.cause = error
    throw failure
  }
  return normalizeFrontendOpenApiConfiguration(parsed, {
    env,
    baseDirectory: dirname(path),
  })
}
