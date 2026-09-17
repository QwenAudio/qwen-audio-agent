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
import { execFileSync } from 'node:child_process'
import { dirname, join, sep } from 'node:path'
import { existsSync } from 'node:fs'

const require = createRequire(import.meta.url)
const lifecycleMetadata = Symbol('qwen-audio-agent.builtin-mcp-lifecycle')
const APP_AGENT_MARKER = '__open-computer-use-app-agent'
const APP_AGENT_DISCOVERY_MS = 500
const APP_AGENT_POLL_MS = 50

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
  const descriptor = {
    name: 'open-computer-use',
    type: 'stdio',
    command: process.execPath,
    args: [binPath, 'mcp'],
    // The bin is a Node script; when the Gateway runs inside Electron the
    // backend inherits execPath, so force plain Node semantics.
    env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }],
  }
  Object.defineProperty(descriptor, lifecycleMetadata, {
    value: { kind: 'open-computer-use' },
  })
  return descriptor
}

export function builtinMcpServers(env = process.env) {
  return [computerUseMcpServer(env)].filter(Boolean)
}

function runningProcesses() {
  if (process.platform !== 'darwin') return []
  try {
    return execFileSync('ps', ['-axo', 'pid=,command='], {
      encoding: 'utf8',
    }).split('\n').flatMap(line => {
      const match = line.trim().match(/^(\d+)\s+(.+)$/)
      return match ? [{ pid: Number(match[1]), command: match[2] }] : []
    })
  } catch {
    return []
  }
}

function isAppAgent(item) {
  return item.command.includes(APP_AGENT_MARKER)
}

function isActiveMcp(item) {
  return (
    /OpenComputerUse(?:\s|$)/.test(item.command)
    && /\smcp(?:\s|$)/.test(item.command)
    && !isAppAgent(item)
  )
}

export function createBuiltinMcpLifecycle(servers, {
  platform = process.platform,
  listProcesses = runningProcesses,
  killImpl = process.kill,
  delay = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms)),
  discoveryMs = APP_AGENT_DISCOVERY_MS,
  now = Date.now,
} = {}) {
  const managesOpenComputerUse = Array.isArray(servers) && servers.some(
    server => server?.[lifecycleMetadata]?.kind === 'open-computer-use',
  )
  if (!managesOpenComputerUse || platform !== 'darwin') {
    return {
      markUsed() {},
      close: () => Promise.resolve(),
    }
  }
  const baseline = new Set(listProcesses().filter(isAppAgent).map(item => item.pid))
  let closePromise
  let used = false
  return {
    markUsed() {
      used = true
    },
    close() {
      if (!used) return Promise.resolve()
      if (closePromise) return closePromise
      closePromise = (async () => {
        const discovered = new Set()
        const deadline = now() + discoveryMs
        do {
          const processes = listProcesses()
          for (const item of processes) {
            if (isAppAgent(item) && !baseline.has(item.pid)) {
              discovered.add(item.pid)
            }
          }
          if (now() >= deadline) break
          await delay(Math.min(APP_AGENT_POLL_MS, discoveryMs))
        } while (true)
        const current = listProcesses()
        if (current.some(isActiveMcp)) return
        const live = new Set(current.map(item => item.pid))
        for (const pid of discovered) {
          if (!live.has(pid)) continue
          try {
            killImpl(pid, 'SIGTERM')
          } catch {
            // The app-agent may exit between process discovery and signaling.
          }
        }
        await delay(100)
        const remaining = new Set(listProcesses().map(item => item.pid))
        for (const pid of discovered) {
          if (!remaining.has(pid)) continue
          try {
            killImpl(pid, 'SIGKILL')
          } catch {
            // Already stopped.
          }
        }
      })()
      return closePromise
    },
  }
}
