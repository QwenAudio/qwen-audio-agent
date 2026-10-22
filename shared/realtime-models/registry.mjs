import { REALTIME_API_PROFILES } from './api-profiles.mjs'
import {
  DEFAULT_DASHSCOPE_REALTIME_MODEL,
  REALTIME_MODEL_BUILTINS,
} from './builtins.mjs'

const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const UNKNOWN_MODEL_CAPABILITIES = Object.freeze({
  textInput: false, audioInput: false, imageInput: false, videoInput: false,
  textOutput: false, audioOutput: false, functionCalling: false,
})
const UNKNOWN_TRANSPORT_CAPABILITIES = Object.freeze({
  textInput: false, audioInput: false, imageInput: false, imageBufferInput: false,
})
const UNKNOWN_SESSION_DEFAULTS = Object.freeze({ voice: null, turnDetection: null })
const UNKNOWN_SESSION_CONSTRAINTS = Object.freeze({})

function invalid(path, reason) {
  throw new TypeError('Realtime model registry ' + path + ': ' + reason)
}

// Accept JSON records only. Inspect descriptors before reading values so an
// accessor cannot execute while validating an otherwise ordinary object.
function entries(value, path, allowedFields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    invalid(path, 'expected an object')
  }
  return Reflect.ownKeys(value).map(key => {
    if (typeof key !== 'string' || DANGEROUS_KEYS.has(key)) {
      invalid(path, 'unsafe configuration key')
    }
    if (allowedFields && !allowedFields.includes(key)) {
      invalid(path + '.' + key, 'unknown field')
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      invalid(path + '.' + key, 'expected a JSON data field')
    }
    return [key, descriptor.value]
  })
}

function record(value, path, allowedFields) {
  return Object.fromEntries(entries(value, path, allowedFields))
}

function modelId(id, path) {
  if (DANGEROUS_KEYS.has(id) || id !== id.trim() || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(id)) {
    invalid(path, 'model ID must contain only letters, digits and . _ : / @ + -')
  }
  return id
}

function nonemptyString(value, path) {
  if (typeof value !== 'string' || !value.trim()) invalid(path, 'expected a non-empty string')
  return value.trim()
}

function parseModel(id, source, provider, path, turnDetectionType) {
  modelId(id, path)
  const fields = record(source, path, ['api', 'label', 'voice'])
  if (!Object.hasOwn(fields, 'api')) invalid(path + '.api', 'required field')
  const api = nonemptyString(fields.api, path + '.api')
  const apiProfiles = REALTIME_API_PROFILES[provider]
  if (!Object.hasOwn(apiProfiles, api)) invalid(path + '.api', 'unsupported API for ' + provider + ': ' + api)
  const preset = apiProfiles[api]
  const label = Object.hasOwn(fields, 'label') ? nonemptyString(fields.label, path + '.label') : id
  const voice = !Object.hasOwn(fields, 'voice') || fields.voice === null
    ? null : nonemptyString(fields.voice, path + '.voice')
  const turnDetection = turnDetectionType === undefined ? preset.turnDetection
    : Object.freeze({ type: nonemptyString(turnDetectionType, path + '.turnDetection') })
  return Object.freeze({
    id,
    label,
    api,
    family: preset.family,
    sessionDefaults: Object.freeze({ voice, turnDetection }),
    modelCapabilities: preset.defaultModelCapabilities,
    transportCapabilities: preset.transportCapabilities,
    sessionConstraints: preset.sessionConstraints,
  })
}

// Pure snapshots: additions never mutate the built-ins or another caller's
// catalogs. No process-global registration and no filesystem/environment reads.
export function createRealtimeModelCatalogs(raw = {}) {
  const root = record(raw, 'root', ['providers'])
  const additions = Object.hasOwn(root, 'providers')
    ? entries(root.providers, 'providers') : []
  const extended = new Map()
  for (const [provider, value] of additions) {
    if (!Object.hasOwn(REALTIME_MODEL_BUILTINS, provider)) {
      invalid('providers.' + provider, 'unsupported provider')
    }
    const path = 'providers.' + provider
    const fields = record(value, path, ['models'])
    if (!Object.hasOwn(fields, 'models')) invalid(path + '.models', 'required field')
    const profiles = entries(fields.models, path + '.models').map(([id, model]) => {
      if (Object.hasOwn(REALTIME_MODEL_BUILTINS[provider].models, id)) {
        invalid(path + '.models.' + id, 'cannot replace a built-in model')
      }
      return parseModel(id, model, provider, path + '.models.' + id)
    })
    extended.set(provider, profiles)
  }
  return Object.freeze(Object.fromEntries(Object.entries(REALTIME_MODEL_BUILTINS).map(([provider, builtin]) => [
    provider,
    Object.freeze({
      environment: builtin.environment,
      defaultModel: builtin.defaultModel,
      profiles: Object.freeze([
        // Built-in models may refine session defaults without extending the user JSON schema.
        ...Object.entries(builtin.models).map(([id, { turnDetection, ...model }]) => (
          parseModel(id, model, provider, 'builtins.' + provider + '.' + id, turnDetection)
        )),
        ...(extended.get(provider) || []),
      ]),
    }),
  ])))
}

export const BUILTIN_REALTIME_MODEL_CATALOGS = createRealtimeModelCatalogs()
export const DASHSCOPE_REALTIME_MODEL_PROFILES = BUILTIN_REALTIME_MODEL_CATALOGS.dashscope.profiles

export function realtimeModelCatalog(provider = 'dashscope', catalogs = BUILTIN_REALTIME_MODEL_CATALOGS) {
  return catalogs && Object.hasOwn(catalogs, provider) ? catalogs[provider] : null
}

function unknownModelProfile(id) {
  return Object.freeze({
    id,
    label: id,
    api: null,
    family: 'unknown',
    sessionDefaults: UNKNOWN_SESSION_DEFAULTS,
    modelCapabilities: UNKNOWN_MODEL_CAPABILITIES,
    transportCapabilities: UNKNOWN_TRANSPORT_CAPABILITIES,
    sessionConstraints: UNKNOWN_SESSION_CONSTRAINTS,
  })
}

export function resolveRealtimeModelProfile(model, provider = 'dashscope', catalogs = BUILTIN_REALTIME_MODEL_CATALOGS) {
  const catalog = realtimeModelCatalog(provider, catalogs)
  const id = String(model || catalog?.defaultModel || '').trim()
  return catalog?.profiles.find(profile => profile.id === id) || unknownModelProfile(id)
}

export function resolveDashScopeRealtimeModelProfile(model = DEFAULT_DASHSCOPE_REALTIME_MODEL, catalogs = BUILTIN_REALTIME_MODEL_CATALOGS) {
  const id = String(model || '').trim() || DEFAULT_DASHSCOPE_REALTIME_MODEL
  return resolveRealtimeModelProfile(id, 'dashscope', catalogs)
}

export function listDashScopeRealtimeModelProfiles(catalogs = BUILTIN_REALTIME_MODEL_CATALOGS) {
  return realtimeModelCatalog('dashscope', catalogs)?.profiles || Object.freeze([])
}
