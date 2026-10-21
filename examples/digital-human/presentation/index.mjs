// Digital-human composition root. Startup validation fails fast on malformed
// config; the per-connection factory negotiates capabilities and hands the
// session runtime an orchestrator. Nothing here discovers arbitrary plugins:
// the provider instance, persona allowlist and media adapter module path all
// come from trusted startup configuration, never from client requests.

import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { DigitalHumanOrchestrator } from './orchestrator.mjs'

const PERSONA_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/
const ALLOWED_RENDERER_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:'])
const SUPPORTED_CAPABILITY_VERSION = 1
const REQUIRED_INPUT_FORMAT = Object.freeze({ encoding: 'pcm_s16le', sampleRate: 24000, channels: 1 })

export {
  DIGITAL_HUMAN_MEDIA_OPEN,
  DIGITAL_HUMAN_MEDIA_CONTROL,
  DIGITAL_HUMAN_STATE,
} from './orchestrator.mjs'
export {
  AudioRoute,
  DIGITAL_HUMAN_CANCEL_REASONS,
  DIGITAL_HUMAN_ERROR_CODES,
  DigitalHumanState,
  SelectorState,
} from './contracts.mjs'
export { createOutputSelector } from './output-selector.mjs'
export { DigitalHumanOrchestrator } from './orchestrator.mjs'

export function assertRendererOriginAllowed(rendererUrl, allowlist) {
  let parsed
  try { parsed = new URL(rendererUrl) } catch {
    throw new Error(`digitalHuman: renderer url ${rendererUrl} is not absolute`)
  }
  const allowed = (allowlist || []).some(entry => {
    try {
      const allowedUrl = new URL(entry)
      return allowedUrl.origin === parsed.origin
    } catch { return false }
  })
  if (!allowed) {
    throw new Error(`digitalHuman: renderer origin ${parsed.origin} is not in the server allowlist`)
  }
  return parsed.origin
}

export function assertDigitalHumanOptions(options) {
  if (options === null || options === undefined) return null
  if (typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('digitalHuman options must be an object or null')
  }
  const { provider, personas, rendererAllowlist, mediaAdapter, firstMediaTimeoutMs } = options
  if (!provider || typeof provider.capabilities !== 'function' || typeof provider.openSession !== 'function') {
    throw new Error('digitalHuman.provider must expose capabilities() and openSession()')
  }
  if (!personas || typeof personas !== 'object' || Array.isArray(personas) || !Object.keys(personas).length) {
    throw new Error('digitalHuman.personas must be a non-empty server-side allowlist')
  }
  for (const [personaId, persona] of Object.entries(personas)) {
    if (!PERSONA_ID_PATTERN.test(personaId)) throw new Error(`digitalHuman.personas: invalid persona id ${personaId}`)
    if (!persona || typeof persona !== 'object' || typeof persona.avatarAssetId !== 'string' || !persona.avatarAssetId) {
      throw new Error(`digitalHuman.personas.${personaId} must define a string avatarAssetId`)
    }
  }
  if (!Array.isArray(rendererAllowlist) || !rendererAllowlist.length) {
    throw new Error('digitalHuman.rendererAllowlist must be a non-empty array of absolute origins')
  }
  for (const entry of rendererAllowlist) {
    let parsed
    try { parsed = new URL(entry) } catch {
      throw new Error(`digitalHuman.rendererAllowlist entry ${entry} is not an absolute url`)
    }
    if (!ALLOWED_RENDERER_PROTOCOLS.has(parsed.protocol)) {
      throw new Error(`digitalHuman.rendererAllowlist entry ${entry} must be http(s)/ws(s)`)
    }
  }
  if (mediaAdapter !== undefined && mediaAdapter !== null) {
    const modulePath = mediaAdapter.modulePath
    if (typeof modulePath !== 'string' || !path.isAbsolute(modulePath)) {
      throw new Error('digitalHuman.mediaAdapter.modulePath must be an absolute filesystem path')
    }
    if (pathToFileURL(modulePath).protocol !== 'file:') {
      throw new Error('digitalHuman.mediaAdapter.modulePath must resolve to a file: url')
    }
  }
  if (firstMediaTimeoutMs !== undefined && (!Number.isInteger(firstMediaTimeoutMs) || firstMediaTimeoutMs <= 0)) {
    throw new Error('digitalHuman.firstMediaTimeoutMs must be a positive integer')
  }
  return options
}

/**
 * Create the per-connection digital-human runtime. Returns null when the
 * provider cannot satisfy the required input format, so the caller keeps the
 * plain audio path without ever touching provider sessions.
 */
export async function createDigitalHumanRuntime({
  options,
  personaId,
  publish,
  onFlushAudio = null,
  log = () => {},
}) {
  assertDigitalHumanOptions(options)
  const persona = options?.personas?.[personaId]
  if (!persona) throw new Error(`digital human persona ${personaId} is not in the server allowlist`)
  const capabilities = await options.provider.capabilities()
  if (capabilities?.version !== SUPPORTED_CAPABILITY_VERSION || capabilities.streamingAudio !== true) {
    throw new Error('digital human provider must support capability version 1 with streaming audio')
  }
  const format = (capabilities.inputAudioFormats || []).find(entry => (
    entry?.encoding === REQUIRED_INPUT_FORMAT.encoding
    && entry.sampleRate === REQUIRED_INPUT_FORMAT.sampleRate
    && entry.channels === REQUIRED_INPUT_FORMAT.channels
  ))
  if (!format) {
    log('format_unsupported', { personaId })
    return null
  }
  const orchestrator = new DigitalHumanOrchestrator({
    provider: options.provider,
    persona: Object.freeze({ personaId, ...persona }),
    format: { ...REQUIRED_INPUT_FORMAT },
    publish,
    onFlushAudio,
    firstMediaTimeoutMs: options.firstMediaTimeoutMs,
    idle: capabilities?.idle === true,
    log,
  })
  orchestrator.personaId = personaId
  orchestrator.capabilities = capabilities
  return orchestrator
}
