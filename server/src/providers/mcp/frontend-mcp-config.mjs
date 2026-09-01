import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

const SERVER_KEY = /^[a-z][a-z0-9_-]{0,39}$/u
const TOOL_NAME = /^[a-zA-Z0-9_.:/-]{1,128}$/u
const ENV_REFERENCE = /^\$\{([A-Z_][A-Z0-9_]*)\}$/u
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u
const MAX_SERVERS = 8
const MAX_TOOLS_PER_SERVER = 32
const MAX_STDIO_ARGS = 64
const MAX_STDIO_ENVIRONMENT = 32

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

function resolveEnvironmentReference(value, env) {
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
    const resolved = resolveEnvironmentReference(content, env)
    if (!/^[a-z0-9-]+$/u.test(header) || /[\r\n]/u.test(resolved)) {
      throw new Error('Frontend MCP contains an invalid header.')
    }
    return [header, resolved]
  }).filter(([, content]) => Boolean(content)))
}

function normalizedStdioEnvironment(value, env) {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Frontend MCP stdio env must be an object.')
  }
  const entries = Object.entries(value)
  if (entries.length > MAX_STDIO_ENVIRONMENT) {
    throw new Error('Frontend MCP stdio env has too many variables.')
  }
  return Object.fromEntries(entries.map(([name, content]) => {
    const variable = clean(name, 80)
    if (!ENV_NAME.test(variable)) {
      throw new Error(`Frontend MCP stdio env name is invalid: ${variable || '(empty)'}`)
    }
    const resolved = resolveEnvironmentReference(content, env)
    if (resolved.includes('\0')) {
      throw new Error(`Frontend MCP stdio env value is invalid: ${variable}`)
    }
    return [variable, resolved]
  }))
}

function normalizedStdioArgs(value, env) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_STDIO_ARGS) {
    throw new Error(`Frontend MCP stdio args must contain at most ${MAX_STDIO_ARGS} strings.`)
  }
  return value.map(argument => {
    if (typeof argument !== 'string') {
      throw new Error('Frontend MCP stdio args must contain only strings.')
    }
    const resolved = resolveEnvironmentReference(argument, env)
    if (resolved.length > 8_192 || resolved.includes('\0')) {
      throw new Error('Frontend MCP stdio argument is invalid.')
    }
    return resolved
  })
}

function normalizedUrl(value, { env, hasHeaders }) {
  let url
  try {
    url = new URL(resolveEnvironmentReference(value, env))
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

function normalizedHttpTransport(value, env) {
  const headers = normalizedHeaders(value.headers, env)
  return {
    type: 'streamable-http',
    url: normalizedUrl(value.url, {
      env,
      hasHeaders: Object.keys(headers).length > 0,
    }),
    headers,
  }
}

function normalizedStdioTransport(value, env) {
  const command = resolveEnvironmentReference(value.command, env)
  if (!command || command.length > 2_048 || command.includes('\0')) {
    throw new Error('Frontend MCP stdio command is invalid.')
  }
  const cwd = value.cwd === undefined
    ? ''
    : resolveEnvironmentReference(value.cwd, env)
  if (cwd && (!isAbsolute(cwd) || cwd.includes('\0'))) {
    throw new Error('Frontend MCP stdio cwd must be an absolute path.')
  }
  return {
    type: 'stdio',
    command,
    args: normalizedStdioArgs(value.args, env),
    env: normalizedStdioEnvironment(value.env, env),
    ...(cwd ? { cwd } : {}),
  }
}

function normalizedTransport(value, env) {
  if (value.transport !== undefined) {
    if (!value.transport || typeof value.transport !== 'object' || Array.isArray(value.transport)) {
      throw new Error('Frontend MCP transport must be an object.')
    }
    if (['url', 'headers', 'command', 'args', 'env', 'cwd'].some(key => key in value)) {
      throw new Error('Frontend MCP transport cannot be mixed with legacy server transport fields.')
    }
    if (value.transport.type === 'streamable-http') {
      if (['command', 'args', 'env', 'cwd'].some(key => key in value.transport)) {
        throw new Error('Frontend MCP Streamable HTTP transport contains stdio fields.')
      }
      return normalizedHttpTransport(value.transport, env)
    }
    if (value.transport.type === 'stdio') {
      if (['url', 'headers'].some(key => key in value.transport)) {
        throw new Error('Frontend MCP stdio transport contains HTTP fields.')
      }
      return normalizedStdioTransport(value.transport, env)
    }
    throw new Error(`Unsupported Frontend MCP transport: ${clean(value.transport.type, 80) || '(missing)'}`)
  }
  const hasUrl = value.url !== undefined
  const hasCommand = value.command !== undefined
  if (hasUrl === hasCommand) {
    throw new Error('Frontend MCP server must define exactly one of url or command.')
  }
  if (hasUrl && ['args', 'env', 'cwd'].some(key => key in value)) {
    throw new Error('Frontend MCP HTTP server contains stdio fields.')
  }
  if (hasCommand && 'headers' in value) {
    throw new Error('Frontend MCP stdio server contains HTTP fields.')
  }
  return hasCommand
    ? normalizedStdioTransport(value, env)
    : normalizedHttpTransport(value, env)
}

function normalizedPolicy(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Frontend MCP tool policy must be an object.')
  }
  const enabled = value.enabled === true
  if ('readOnly' in value || 'approval' in value) {
    throw new Error(
      'Frontend MCP configuration does not define readOnly or approval; use MCP tool annotations and enforce confirmation in the tool service.',
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

function normalizedServer(key, value, env) {
  if (!SERVER_KEY.test(key)) throw new Error(`Invalid Frontend MCP server key: ${key}`)
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Frontend MCP server ${key} must be an object.`)
  }
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
    connectTimeoutMs: boundedInteger(
      value.connectTimeoutMs,
      8_000,
      100,
      30_000,
    ),
    transport: normalizedTransport(value, env),
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
