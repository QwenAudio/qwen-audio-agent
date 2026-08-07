// Built-in MCP servers injected into every backend Agent Session.
//
// ACP treats stdio as the baseline MCP transport: descriptors passed via
// `session/new` are spawned and connected by the backend Agent itself, so
// the Gateway only needs to describe where the server lives. Verified
// against Qoder and OpenCode — both spawn the stdio process directly.
//
// open-computer-use ships three platform runtimes in one npm package and
// provides click/type/screenshot-style tools, giving every backend a
// computer-use baseline even when the user has not configured one.
import { createRequire } from 'node:module'
import { dirname, join, sep } from 'node:path'
import { existsSync } from 'node:fs'

const require = createRequire(import.meta.url)

function settingEnabled(value, fallback = true) {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (!normalized) return fallback
  return !['false', 'off', '0', 'no', 'disabled'].includes(normalized)
}

// Inside Electron, require.resolve returns paths within the asar archive.
// Backend Agents are external processes that cannot read archived files, so
// point them at the asarUnpack mirror instead.
function externallyReadable(path) {
  return path.replace(
    `${sep}app.asar${sep}`,
    `${sep}app.asar.unpacked${sep}`,
  )
}

function resolvePackageBin(specifier, binName) {
  try {
    const packagePath = require.resolve(`${specifier}/package.json`)
    const manifest = require(`${specifier}/package.json`)
    const relative = typeof manifest.bin === 'string'
      ? manifest.bin
      : manifest.bin?.[binName]
    if (!relative) return null
    const binPath = externallyReadable(join(dirname(packagePath), relative))
    return existsSync(binPath) ? binPath : null
  } catch {
    return null
  }
}

export function computerUseMcpServer(env = process.env) {
  if (!settingEnabled(env.QWEN_AUDIO_AGENT_COMPUTER_USE)) return null
  const binPath = resolvePackageBin(
    '@qwen-code/open-computer-use',
    'open-computer-use',
  )
  if (!binPath) return null
  return {
    name: 'open-computer-use',
    command: process.execPath,
    args: [binPath, 'mcp'],
    // The bin is a Node script; when the Gateway runs inside Electron the
    // backend inherits execPath, so force plain Node semantics.
    env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }],
  }
}

export function builtinMcpServers(env = process.env) {
  return [computerUseMcpServer(env)].filter(Boolean)
}
