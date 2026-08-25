import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SERVER_KEY = /^[a-z][a-z0-9_-]{0,39}$/u
const TOOL_NAME = /^[a-zA-Z0-9_.:/-]{1,128}$/u
const ENV_REFERENCE = /^\$\{([A-Z_][A-Z0-9_]*)\}$/u
const MAX_SERVERS = 8
const MAX_TOOLS_PER_SERVER = 32

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value)
  if (value === undefined) return fallback
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Frontend MCP policy value must be ${minimum}-${maximum}.`)
  }
  return parsed
}

function clean(value, maxChars = 1_000) {
  return [...String(value || '').trim()].slice(0, maxChars).join('')
}

function resolveSecret(value, env) {
  const source = clean(value, 8_192)
  const match = ENV_REFERENCE.exec(source)
  if (!match) return source
  const resolved = clean(env[match[1]], 8_192)
  if (!resolved) {
    throw new Error(`Frontend MCP environment variable is missing: ${match[1]}`)
  }
  return resolved
}

function normalizedHeaders(value, env) {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Frontend MCP headers must be an object.')
  }
  const entries = Object.entries(value)
  if (entries.length > 16) throw new Error('Frontend MCP has too many headers.')
  return Object.fromEntries(entries.map(([name, content]) => {
    const header = clean(name, 80).toLowerCase()
    const resolved = resolveSecret(content, env)
    if (!/^[a-z0-9-]+$/u.test(header) || /[\r\n]/u.test(resolved)) {
      throw new Error('Frontend MCP contains an invalid header.')
    }
    return [header, resolved]
  }).filter(([, content]) => Boolean(content)))
}

function normalizedUrl(value, { hasHeaders }) {
  let url
  try {
    url = new URL(clean(value, 2_048))
  } catch {
    throw new Error('Frontend MCP URL is invalid.')
  }
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
  if (
    url.username
    || url.password
    || url.hash
    || !['http:', 'https:'].includes(url.protocol)
    || (url.protocol !== 'https:' && (!loopback || hasHeaders))
  ) {
    throw new Error(
      'Remote Frontend MCP requires HTTPS; local HTTP cannot carry headers.',
    )
  }
  return url.toString()
}

function normalizedPolicy(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Frontend MCP tool policy must be an object.')
  }
  const enabled = value.enabled === true
  const readOnly = value.readOnly === true
  if (enabled && !readOnly) {
    throw new Error(
      'Frontend MCP tools must be explicitly enabled and readOnly in this release.',
    )
  }
  return {
    enabled,
    readOnly,
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

function normalizedServer(key, value, env) {
  if (!SERVER_KEY.test(key)) throw new Error(`Invalid Frontend MCP server key: ${key}`)
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Frontend MCP server ${key} must be an object.`)
  }
  const headers = normalizedHeaders(value.headers, env)
  const tools = value.tools === undefined ? {} : value.tools
  if (!tools || typeof tools !== 'object' || Array.isArray(tools)) {
    throw new Error(`Frontend MCP server ${key} tools must be an object.`)
  }
  const toolEntries = Object.entries(tools)
  if (toolEntries.length > MAX_TOOLS_PER_SERVER) {
    throw new Error(`Frontend MCP server ${key} has too many tool policies.`)
  }
  return {
    key,
    enabled: value.enabled === true,
    transport: {
      type: 'streamable-http',
      url: normalizedUrl(value.url, {
        hasHeaders: Object.keys(headers).length > 0,
      }),
      headers,
    },
    tools: Object.fromEntries(toolEntries.map(([toolName, policy]) => {
      if (!TOOL_NAME.test(toolName)) {
        throw new Error(`Invalid Frontend MCP tool name: ${toolName}`)
      }
      return [toolName, normalizedPolicy(policy)]
    })),
  }
}

export function normalizeFrontendMcpConfiguration(value, { env = process.env } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Frontend MCP configuration must be an object.')
  }
  if (value.version !== 1) {
    throw new Error('Frontend MCP configuration version must be 1.')
  }
  const servers = value.servers === undefined ? {} : value.servers
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    throw new Error('Frontend MCP servers must be an object.')
  }
  const entries = Object.entries(servers)
  if (entries.length > MAX_SERVERS) {
    throw new Error(`Frontend MCP supports at most ${MAX_SERVERS} servers.`)
  }
  return {
    version: 1,
    servers: entries.map(([key, server]) => normalizedServer(key, server, env)),
  }
}

export function loadFrontendMcpConfiguration({
  filePath = process.env.QWEN_AUDIO_FRONTEND_MCP_CONFIG,
  env = process.env,
} = {}) {
  const configuredPath = clean(filePath, 2_048)
  if (!configuredPath) return { version: 1, servers: [] }
  const path = resolve(configuredPath)
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    const failure = new Error(`Unable to read Frontend MCP configuration: ${error.message}`)
    failure.code = 'frontend_mcp_config_unavailable'
    throw failure
  }
  return normalizeFrontendMcpConfiguration(parsed, { env })
}
