import { readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

const PROFILE_KEYS = new Set([
  '$schema',
  'version',
  'name',
  'description',
  'assistant',
  'toolSources',
])
const TOOL_SOURCE_KEYS = new Set(['mcp', 'openapi'])

function clean(value, maxChars = 1_000) {
  return [...String(value || '').replace(/\s+/gu, ' ').trim()]
    .slice(0, maxChars)
    .join('')
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`)
  }
}

function assertKnownKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter(key => !allowed.has(key))
  if (unknown.length) {
    throw new Error(`${label} contains unsupported fields: ${unknown.join(', ')}.`)
  }
}

function optionalText(value, { field, maxChars }) {
  if (value === undefined) return ''
  if (typeof value !== 'string') {
    throw new Error(`Frontend Profile ${field} must be a string.`)
  }
  return clean(value, maxChars)
}

function bundlePath(value, { baseDirectory, field }) {
  const source = optionalText(value, { field, maxChars: 2_048 })
  if (!source) return ''
  if (isAbsolute(source) || /^(?:[a-z][a-z0-9+.-]*:|[\\/]{2})/iu.test(source)) {
    throw new Error(`Frontend Profile ${field} must be a relative local path.`)
  }
  const path = resolve(baseDirectory, source)
  const relativePath = relative(baseDirectory, path)
  if (
    !relativePath
    || relativePath === '..'
    || relativePath.startsWith('../')
    || relativePath.startsWith('..\\')
    || isAbsolute(relativePath)
  ) {
    throw new Error(`Frontend Profile ${field} must stay inside its profile directory.`)
  }
  let stats
  try {
    stats = statSync(path)
  } catch (error) {
    throw new Error(`Frontend Profile ${field} is unavailable: ${error.message}`)
  }
  if (!stats.isFile()) {
    throw new Error(`Frontend Profile ${field} must reference a file.`)
  }
  const realBase = realpathSync(baseDirectory)
  const realPath = realpathSync(path)
  const realRelativePath = relative(realBase, realPath)
  if (
    realRelativePath === '..'
    || realRelativePath.startsWith('../')
    || realRelativePath.startsWith('..\\')
    || isAbsolute(realRelativePath)
  ) {
    throw new Error(`Frontend Profile ${field} must stay inside its profile directory.`)
  }
  return path
}

export function emptyFrontendProfile() {
  return {
    version: 1,
    configured: false,
    name: 'default',
    description: '',
    assistantProfilePath: '',
    frontendMcpConfigPath: '',
    frontendOpenApiConfigPath: '',
  }
}

export function normalizeFrontendProfile(value, {
  baseDirectory = process.cwd(),
} = {}) {
  assertObject(value, 'Frontend Profile')
  assertKnownKeys(value, PROFILE_KEYS, 'Frontend Profile')
  if (value.$schema !== undefined && typeof value.$schema !== 'string') {
    throw new Error('Frontend Profile $schema must be a string.')
  }
  if (value.version !== 1) {
    throw new Error('Frontend Profile version must be 1.')
  }
  const name = optionalText(value.name, { field: 'name', maxChars: 80 })
  if (!name) throw new Error('Frontend Profile requires a name.')
  const toolSources = value.toolSources === undefined ? {} : value.toolSources
  assertObject(toolSources, 'Frontend Profile toolSources')
  assertKnownKeys(toolSources, TOOL_SOURCE_KEYS, 'Frontend Profile toolSources')
  const profile = {
    version: 1,
    configured: true,
    name,
    description: optionalText(value.description, {
      field: 'description',
      maxChars: 280,
    }),
    assistantProfilePath: bundlePath(value.assistant, {
      baseDirectory,
      field: 'assistant',
    }),
    frontendMcpConfigPath: bundlePath(toolSources.mcp, {
      baseDirectory,
      field: 'toolSources.mcp',
    }),
    frontendOpenApiConfigPath: bundlePath(toolSources.openapi, {
      baseDirectory,
      field: 'toolSources.openapi',
    }),
  }
  if (![
    profile.assistantProfilePath,
    profile.frontendMcpConfigPath,
    profile.frontendOpenApiConfigPath,
  ].some(Boolean)) {
    throw new Error('Frontend Profile must reference an assistant or tool source.')
  }
  return profile
}

export function loadFrontendProfile({
  filePath = process.env.QWEN_AUDIO_FRONTEND_PROFILE,
} = {}) {
  const configuredPath = clean(filePath, 2_048)
  if (!configuredPath) return emptyFrontendProfile()
  const path = resolve(configuredPath)
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    const failure = new Error(`Unable to read Frontend Profile: ${error.message}`)
    failure.cause = error
    throw failure
  }
  return normalizeFrontendProfile(parsed, { baseDirectory: dirname(path) })
}

export function resolveFrontendProfileConfiguration({
  profile = emptyFrontendProfile(),
  env = process.env,
  defaultAssistantProfilePath = '',
  baseDirectory = process.cwd(),
} = {}) {
  const explicit = name => clean(env[name], 2_048)
  const explicitAssistant = explicit('QWEN_AUDIO_AGENT_ASSISTANT_PROFILE_PATH')
  return {
    frontendProfile: {
      configured: profile.configured === true,
      name: clean(profile.name, 80) || 'default',
      description: clean(profile.description, 280),
    },
    assistantProfilePath: (explicitAssistant
      ? resolve(baseDirectory, explicitAssistant)
      : '')
      || profile.assistantProfilePath
      || defaultAssistantProfilePath,
    frontendMcpConfigPath: explicit('QWEN_AUDIO_FRONTEND_MCP_CONFIG')
      || profile.frontendMcpConfigPath
      || '',
    frontendOpenApiConfigPath: explicit('QWEN_AUDIO_FRONTEND_OPENAPI_CONFIG')
      || profile.frontendOpenApiConfigPath
      || '',
  }
}
