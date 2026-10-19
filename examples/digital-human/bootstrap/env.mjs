// Example-local configuration. Reads .env.local (never committed) and exposes a
// plain object so the bootstrap steps stay testable without touching process.env
// at import time. Mirrors the smart-cockpit bootstrap convention.

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const EXAMPLE_ROOT = fileURLToPath(new URL('..', import.meta.url))
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
export const ROOT_ENV_FILE = `${REPO_ROOT}.env.local`

export function loadEnvFile(envFile = `${EXAMPLE_ROOT}.env.local`) {
  if (envFile && existsSync(envFile)) process.loadEnvFile(envFile)
  return envFile
}

// Reads a single KEY=value from a .env file without loading the rest, so the
// demo can borrow one credential from the product's root .env.local without
// inheriting unrelated product settings (e.g. AGENT_PROTOCOL or backend bins).
function readEnvValue(file, key) {
  if (!file || !existsSync(file)) return null
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    if (line.slice(0, eq).trim() !== key) continue
    return line.slice(eq + 1).trim().replace(/^["']|["']$/g, '') || null
  }
  return null
}

// Loads the example's own .env.local in full, then falls back to the repo-root
// .env.local for the realtime key only. Returns the resolved key (or null).
export function loadDemoEnv({ key = 'DASHSCOPE_API_KEY' } = {}) {
  loadEnvFile()
  if (!process.env[key]) {
    const value = readEnvValue(ROOT_ENV_FILE, key)
    if (value) process.env[key] = value
  }
  return process.env[key] || null
}

export function readConfig(env = process.env) {
  return {
    gatewayHost: env.DH_GATEWAY_HOST || '127.0.0.1',
    gatewayPort: Number(env.DH_GATEWAY_PORT || 18895),
    // Empty rendererUrl means start.mjs launches the local Mock renderer.
    rendererUrl: (env.DH_RENDERER_URL || '').trim(),
    // Bearer token for a remote renderer control plane (e.g. FlashHead). Null
    // for the local Mock, which needs no auth. Trusted startup config; never logged.
    rendererToken: env.DH_RENDERER_TOKEN || null,
    persona: env.DH_PERSONA || 'mock-default',
    mockFault: (env.DH_MOCK_FAULT || '').trim() || null,
    mockRendererHost: env.DH_MOCK_RENDERER_HOST || '127.0.0.1',
    mockRendererPort: Number(env.DH_MOCK_RENDERER_PORT || 0),
    // Absolute path to the media adapter the worker imports to join the
    // renderer's private media channel. Trusted startup configuration only.
    mediaAdapterPath: `${EXAMPLE_ROOT}media/framed-av-source.mjs`,
  }
}
