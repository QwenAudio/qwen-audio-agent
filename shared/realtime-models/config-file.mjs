// Node boundary only. Registry data and validation remain browser-safe;
// hosts load one snapshot and pass it to their configuration consumers.
import { closeSync, openSync, readSync } from 'node:fs'
import { resolve } from 'node:path'
import { userConfigDirectory } from '../runtime-paths.mjs'
import { BUILTIN_REALTIME_MODEL_CATALOGS, createRealtimeModelCatalogs } from './registry.mjs'

export const FRONTEND_MODELS_CONFIG_ENV = 'QWEN_AUDIO_FRONTEND_MODELS_CONFIG'
export const FRONTEND_MODELS_CONFIG_FILE = 'frontend-models.json'
const MAX_CONFIG_BYTES = 1024 * 1024

function configError(message) {
  return Object.assign(new Error(message), { code: 'QWAUDIO_REALTIME_MODEL_CONFIG_INVALID' })
}

export function realtimeModelConfigPath(env = process.env, {
  configDirectory = userConfigDirectory(env),
} = {}) {
  return resolve(configDirectory, String(env[FRONTEND_MODELS_CONFIG_ENV] || '').trim()
    || FRONTEND_MODELS_CONFIG_FILE)
}

export function loadRealtimeModelCatalogs(env = process.env, options = {}) {
  const path = realtimeModelConfigPath(env, options)
  let fd
  try {
    fd = openSync(path, 'r')
  } catch (error) {
    if (error.code === 'ENOENT' && !String(env[FRONTEND_MODELS_CONFIG_ENV] || '').trim()) {
      return BUILTIN_REALTIME_MODEL_CATALOGS
    }
    throw configError(`Cannot read frontend model catalog ${path} (${error.code || 'read error'})`)
  }
  let source
  try {
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null)
      if (!read) break
      length += read
    }
    if (length > MAX_CONFIG_BYTES) throw new Error('file exceeds 1 MiB')
    source = buffer.toString('utf8', 0, length)
  } catch (error) {
    throw configError(`Cannot read frontend model catalog ${path} (${error.code || error.message})`)
  } finally {
    closeSync(fd)
  }
  let raw
  try {
    raw = JSON.parse(source)
  } catch {
    throw configError(`Invalid JSON in frontend model catalog ${path}`)
  }
  try {
    return createRealtimeModelCatalogs(raw)
  } catch (error) {
    throw configError(`Invalid frontend model catalog ${path}: ${error.message}`)
  }
}
