import { closeSync, fsyncSync, mkdirSync, openSync, chmodSync, readFileSync, writeSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseEnv } from 'node:util'
import {
  replaceFileSync,
  withFileTransaction,
} from '../../shared/file-transaction-lock.mjs'
import {
  normalizeRealtimeProvider,
  realtimeModelCatalog,
  resolveRealtimeModelProfile,
} from '../../shared/realtime-provider-catalog.mjs'

export const GATEWAY_RESTART_FOLLOW_UP = '配置已更新；请执行 qwenaudio gateway restart 使 Gateway 使用新模型'

function configText(path) {
  try { return readFileSync(path, 'utf8') } catch (error) {
    if (error.code === 'ENOENT') return ''
    throw error
  }
}

export function resolveConfigModel(env = {}, content = '') {
  const values = { ...parseEnv(content), ...env }
  const catalog = realtimeModelCatalog(normalizeRealtimeProvider(values.QWEN_AUDIO_REALTIME_PROVIDER))
  return catalog ? String(values[catalog.environment] || catalog.defaultModel).trim() : ''
}

export function assertKnownRealtimeModel(model, provider = 'dashscope') {
  const profile = resolveRealtimeModelProfile(model, provider)
  if (!realtimeModelCatalog(provider)?.profiles.some(item => item.id === model)) {
    throw new Error(`不支持的 Realtime 模型：${model}`)
  }
  return profile
}

export function updateRealtimeModelConfig(configPath, model, {
  fsyncDirectory = true,
  env = {},
} = {}) {
  return withFileTransaction(configPath, () => updateRealtimeModelConfigUnlocked(
    configPath,
    model,
    { fsyncDirectory, env },
  ))
}

function updateRealtimeModelConfigUnlocked(configPath, model, {
  fsyncDirectory,
  env,
}) {
  const existing = configText(configPath)
  const values = { ...parseEnv(existing), ...env }
  const provider = normalizeRealtimeProvider(values.QWEN_AUDIO_REALTIME_PROVIDER)
  const profile = assertKnownRealtimeModel(model, provider)
  const environment = realtimeModelCatalog(provider).environment
  const assignments = new Map([
    [environment, model],
  ])
  const newline = existing.includes('\r\n') ? '\r\n' : '\n'
  const lines = existing ? existing.split(/\r?\n/) : []
  if (lines.at(-1) === '') lines.pop()
  const replaced = new Set()
  const normalized = []
  for (const current of lines) {
    const match = current.match(/^\s*([A-Z][A-Z0-9_]*)\s*=.*$/)
    const key = match?.[1]
    if (!assignments.has(key)) {
      normalized.push(current)
      continue
    }
    if (!replaced.has(key)) normalized.push(`${key}=${assignments.get(key)}`)
    replaced.add(key)
  }
  for (const [key, value] of assignments) {
    if (!replaced.has(key)) normalized.push(`${key}=${value}`)
  }
  const updated = `${normalized.join(newline)}${newline}`
  const directory = dirname(configPath)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const tempPath = resolve(directory, `.config.env.${process.pid}.${randomUUID()}.tmp`)
  const fd = openSync(tempPath, 'wx', 0o600)
  try {
    chmodSync(tempPath, 0o600)
    writeSync(fd, updated, 0, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  replaceFileSync(tempPath, configPath)
  if (fsyncDirectory) {
    try {
      const directoryFd = openSync(directory, 'r')
      try { fsyncSync(directoryFd) } finally { closeSync(directoryFd) }
    } catch {}
  }
  return {
    model,
    profile,
    environment,
    configPath,
  }
}

export function showConfig({ configPath, env = {}, content = configText(configPath) }) {
  const values = { ...parseEnv(content), ...env }
  const provider = normalizeRealtimeProvider(values.QWEN_AUDIO_REALTIME_PROVIDER)
  const catalog = realtimeModelCatalog(provider)
  const model = resolveConfigModel(env, content)
  return [
    `Realtime 前台：${provider}`,
    `Realtime 模型：${model || '由上游服务配置'}`,
    ...(catalog ? [
      '可用 Realtime 模型：',
      ...catalog.profiles.map(profile => `- ${profile.id}（${profile.label}）`),
    ] : []),
  ].join('\n')
}
