// OpenCode ACP / managed-server launcher (node module — cross-platform).
// Merges the old opencode-acp and opencode-server shell scripts.
// Usage:  node opencode.mjs acp         (ACP entry)
//         node opencode.mjs serve       (managed server)
//         node opencode.mjs <command>   (arbitrary opencode subcommand)
import { spawnAndProxy, commandAvailable } from './lib/launcher.mjs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(join(fileURLToPath(import.meta.url), '..', '..'))
const MODE = process.argv[2] || 'serve'
const EXTRA = process.argv.slice(3)

// ── defaults ────────────────────────────────────────────────────────────────
const PORT = process.env.OPENCODE_PORT || '4096'
const RUNTIME = process.env.OPENCODE_RUNTIME || 'auto'
const PKG = process.env.OPENCODE_PACKAGE || 'opencode-ai@1.18.5'
const MIN_VERSION = process.env.OPENCODE_MIN_VERSION || '1.18.0'
const COMMAND = MODE === 'acp' ? 'acp' : MODE === 'gateway' ? 'gateway' : 'serve'
const BACKEND_MODEL = process.env.QWEN_AUDIO_AGENT_BACKEND_MODEL || ''
const DESKTOP_INSTALLED_ONLY = process.env.QWEN_AUDIO_AGENT_DESKTOP_INSTALLED_ONLY

// ── helpers ──────────────────────────────────────────────────────────────────

function fatal(msg) { console.error(msg); process.exit(1) }

function parseVersion(v) {
  const m = String(v).match(/(\d+)\.(\d+)\.(\d+)/)
  return m ? m.slice(1).map(Number) : null
}

function versionGte(actual, min) {
  const a = parseVersion(actual), m = parseVersion(min)
  if (!a || !m) return false
  for (let i = 0; i < 3; i++) { if (a[i] > m[i]) return true; if (a[i] < m[i]) return false }
  return true
}

async function installedVersion() {
  let stdout = ''
  const code = await spawnAndProxy('opencode', ['--version'], {
    inheritStdio: false,
    onStdout: chunk => { stdout += chunk },
  })
  return code === 0 ? stdout.trim().split(/\r?\n/)[0] : ''
}

// ── env setup ────────────────────────────────────────────────────────────────

if (!process.env.OPENCODE_MODEL && BACKEND_MODEL && BACKEND_MODEL.toLowerCase() !== 'auto') {
  const modelId = BACKEND_MODEL.includes('/') ? BACKEND_MODEL.split('/')[1] : BACKEND_MODEL
  process.env.OPENCODE_MODEL = `alibaba-cn/${modelId}`
}

if (process.env.QWEN_AUDIO_AGENT_OPENCODE_XDG_CONFIG_HOME) {
  process.env.XDG_CONFIG_HOME = process.env.QWEN_AUDIO_AGENT_OPENCODE_XDG_CONFIG_HOME
} else if (process.env.QWEN_AUDIO_AGENT_OPENCODE_ISOLATE_USER_CONFIG === 'true') {
  process.env.XDG_CONFIG_HOME = `${process.env.QWEN_AUDIO_AGENT_ROOT || ROOT}/runtime/opencode-xdg`
}

// ── runtime runners ──────────────────────────────────────────────────────────

async function runBinary() {
  const bin = process.env.OPENCODE_BIN
  if (!bin) fatal('OPENCODE_RUNTIME=binary requires OPENCODE_BIN.')
  const args = COMMAND === 'serve'
    ? ['serve', '--hostname', '127.0.0.1', '--port', PORT, ...EXTRA]
    : [COMMAND, ...EXTRA]
  await spawnAndProxy(bin, args)
}

async function runInstalled() {
  if (!commandAvailable('opencode')) fatal('OPENCODE_RUNTIME=installed requires opencode on PATH.')
  const ver = await installedVersion()
  if (!versionGte(ver, MIN_VERSION)) {
    fatal(`Installed OpenCode ${ver} is older than the supported minimum ${MIN_VERSION}.`)
  }
  const args = COMMAND === 'serve'
    ? ['serve', '--hostname', '127.0.0.1', '--port', PORT, ...EXTRA]
    : [COMMAND, ...EXTRA]
  await spawnAndProxy('opencode', args)
}

async function runPackage() {
  if (DESKTOP_INSTALLED_ONLY === '1') {
    fatal('OpenCode is not installed. Install OpenCode before selecting it in the desktop app.')
  }
  if (!commandAvailable('npx')) fatal('OpenCode package mode requires npx.')
  const args = COMMAND === 'serve'
    ? ['--yes', PKG, 'serve', '--hostname', '127.0.0.1', '--port', PORT, ...EXTRA]
    : ['--yes', PKG, COMMAND, ...EXTRA]
  await spawnAndProxy('npx', args)
}

async function runManagedPackage() {
  if (!process.env.DASHSCOPE_API_KEY) fatal('Automatic OpenCode setup requires DASHSCOPE_API_KEY.')
  if (!BACKEND_MODEL || BACKEND_MODEL.toLowerCase() === 'auto') {
    fatal('Automatic OpenCode setup requires QWEN_AUDIO_AGENT_BACKEND_MODEL.')
  }
  await runPackage()
}

// ── route ────────────────────────────────────────────────────────────────────

switch (RUNTIME) {
  case 'binary':
    if (!process.env.OPENCODE_BIN) fatal('OPENCODE_RUNTIME=binary requires OPENCODE_BIN.')
    await runBinary(); break
  case 'source': fatal('Source runtime not supported via Node launcher.'); break
  case 'package': await runPackage(); break
  case 'installed': await runInstalled(); break
  case 'auto': break
  default: fatal(`Unknown OPENCODE_RUNTIME: ${RUNTIME}`)
}

if (RUNTIME === 'auto') {
  if (process.env.OPENCODE_BIN) {
    await runBinary()
  } else if (commandAvailable('opencode')) {
    const ver = await installedVersion()
    if (versionGte(ver, MIN_VERSION)) {
      await runInstalled()
    } else if (DESKTOP_INSTALLED_ONLY === '1') {
      fatal(`Installed OpenCode ${ver} is older than the supported minimum ${MIN_VERSION}.`)
    } else {
      console.error(`Installed OpenCode ${ver} is older than the supported minimum; using ${PKG}.`)
      await runManagedPackage()
    }
  } else {
    await runManagedPackage()
  }
}

process.exit(0)
