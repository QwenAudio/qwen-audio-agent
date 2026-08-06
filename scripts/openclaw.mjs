// OpenClaw ACP / Gateway launcher (node module — cross-platform).
// Replaces scripts/openclaw shell script.
import { spawnAndProxy, commandAvailable, loadDotEnv } from './lib/launcher.mjs'
import { spawnSync } from 'node:child_process'
import { mkdirSync, copyFileSync, existsSync, writeFileSync, renameSync, readdirSync, statSync, symlinkSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomInt } from 'node:crypto'

const ROOT = resolve(join(fileURLToPath(import.meta.url), '..', '..'))
const IS_WIN = process.platform === 'win32'
const IS_DESKTOP = process.env.QWEN_AUDIO_AGENT_DESKTOP === '1'
const DESKTOP_INSTALLED_ONLY = process.env.QWEN_AUDIO_AGENT_DESKTOP_INSTALLED_ONLY
const FIRST_ARG = process.argv[2] || ''
const CLI_ARGS = process.argv.slice(2)

loadDotEnv(resolve(ROOT))

function fatal(msg) { console.error(msg); process.exit(1) }

// ── config dir ───────────────────────────────────────────────────────────────

function userConfigDir() {
  if (process.env.QWAUDIO_CONFIG_DIR) return process.env.QWAUDIO_CONFIG_DIR
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, 'qwaudio')
  const home = process.env.HOME || process.env.USERPROFILE
  if (home) return join(home, '.config', 'qwaudio')
  fatal('OpenClaw requires QWAUDIO_CONFIG_DIR, XDG_CONFIG_HOME, or HOME.')
}

// ── run Node helper scripts ──────────────────────────────────────────────────

const SOURCE_ROOT = process.env.QWEN_AUDIO_AGENT_SOURCE_ROOT || ROOT

function runHelper(op, ...args) {
  const isDesktopHelper = SOURCE_ROOT !== ROOT
  const script = isDesktopHelper
    ? resolve(SOURCE_ROOT, 'server/src/process/openclaw-desktop-helper.mjs')
    : (op === 'prepare'
        ? resolve(ROOT, 'scripts/prepare-openclaw-config.mjs')
        : resolve(ROOT, 'scripts/sync-openclaw-gateway-token.mjs'))
  const env = IS_DESKTOP ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env
  // Desktop helper 接受 op 作为首参数；独立脚本（prepare/sync-token）不接受。
  const scriptArgs = isDesktopHelper ? [op, ...args] : args
  return spawnSync(process.execPath, [script, ...scriptArgs], { env, stdio: 'inherit' })
}

// ── directory setup ──────────────────────────────────────────────────────────

const USER_DIR = userConfigDir()
const STATE_DIR = process.env.QWEN_AUDIO_AGENT_OPENCLAW_STATE_DIR || join(USER_DIR, 'backends', 'openclaw', 'state')
const WORKSPACE = process.env.QWEN_AUDIO_AGENT_OPENCLAW_WORKSPACE || join(USER_DIR, 'workspaces', 'openclaw')
process.env.QWEN_AUDIO_AGENT_OPENCLAW_STATE_DIR = STATE_DIR
process.env.QWEN_AUDIO_AGENT_OPENCLAW_WORKSPACE = WORKSPACE
mkdirSync(STATE_DIR, { recursive: true })
mkdirSync(WORKSPACE, { recursive: true })
const agentsSrc = join(ROOT, 'config', 'openclaw', 'workspace', 'AGENTS.md')
const agentsDst = join(WORKSPACE, 'AGENTS.md')
if (!existsSync(agentsDst) && existsSync(agentsSrc)) copyFileSync(agentsSrc, agentsDst)

// ── managed (DashScope) OpenClaw ─────────────────────────────────────────────

let managed = false
const MODEL = (process.env.QWEN_AUDIO_AGENT_BACKEND_MODEL || '').toLowerCase()
if (!process.env.OPENCLAW_CONFIG_PATH && process.env.DASHSCOPE_API_KEY && MODEL && MODEL !== 'auto') {
  managed = true
  const cfgDir = join(USER_DIR, 'backends', 'openclaw')
  mkdirSync(cfgDir, { recursive: true })
  copyFileSync(join(ROOT, 'config', 'openclaw', 'openclaw.json5'), join(cfgDir, 'openclaw.json5'))
  process.env.OPENCLAW_CONFIG_PATH = join(cfgDir, 'openclaw.json5')
  const modelId = process.env.QWEN_AUDIO_AGENT_BACKEND_MODEL.includes('/')
    ? process.env.QWEN_AUDIO_AGENT_BACKEND_MODEL.split('/')[1] : process.env.QWEN_AUDIO_AGENT_BACKEND_MODEL
  process.env.QWEN_AUDIO_AGENT_OPENCLAW_MODEL = `bailian/${modelId}`
  process.env.QWEN_AUDIO_AGENT_OPENCLAW_MODEL_ID = modelId
}

// ── gateway-specific setup ───────────────────────────────────────────────────

if (FIRST_ARG === 'gateway') {
  if (!managed && !process.env.OPENCLAW_CONFIG_PATH) {
    const home = process.env.HOME || process.env.USERPROFILE
    if (home && existsSync(join(home, '.openclaw', 'openclaw.json'))) {
      process.env.OPENCLAW_CONFIG_PATH = join(home, '.openclaw', 'openclaw.json')
    }
  }
  const port = process.env.OPENCLAW_PORT || '18789'
  const runtimeDir = join(STATE_DIR, `gateway-${port}`)
  mkdirSync(runtimeDir, { recursive: true })
  process.env.OPENCLAW_STATE_DIR = runtimeDir
  if (!managed && process.env.OPENCLAW_CONFIG_PATH) {
    const userCfg = process.env.OPENCLAW_CONFIG_PATH
    const userState = dirname(userCfg)
    const runtimeCfg = join(runtimeDir, 'openclaw.json')
    runHelper('prepare', userCfg, runtimeCfg)
    process.env.OPENCLAW_CONFIG_PATH = runtimeCfg
    for (const cap of ['extensions', 'skills', 'plugin-skills', 'service-env']) {
      const src = join(userState, cap), dst = join(runtimeDir, cap)
      if (existsSync(src) && !existsSync(dst)) {
        try { if (IS_WIN) copyDir(src, dst); else symlinkSync(src, dst, 'dir') } catch { /* ok */ }
      }
    }
  }
}

// ── gateway token ────────────────────────────────────────────────────────────

let token = process.env.OPENCLAW_GATEWAY_TOKEN || process.env.AGENT_API_KEY || ''
if (!token && managed && process.env.QWEN_AUDIO_AGENT_AUTH_SECRET) {
  token = process.env.QWEN_AUDIO_AGENT_AUTH_SECRET
}
process.env.OPENCLAW_GATEWAY_TOKEN = token
const tokenFile = process.env.OPENCLAW_GATEWAY_TOKEN_FILE || join(STATE_DIR, 'gateway-token')
if (token) {
  const tmp = `${tokenFile}.tmp.${randomInt(0, 99999)}`
  writeFileSync(tmp, `${token}\n`, { mode: 0o600 })
  renameSync(tmp, tokenFile)
} else if (FIRST_ARG === 'gateway') {
  runHelper('sync-token', tokenFile)
}
process.env.OPENCLAW_GATEWAY_TOKEN_FILE = tokenFile

// ── runtime routing ──────────────────────────────────────────────────────────

const RUNTIME = process.env.OPENCLAW_RUNTIME || 'auto'
const PKG = process.env.OPENCLAW_PACKAGE || 'openclaw@2026.6.33'
const BUNDLE_BIN = process.env.OPENCLAW_BUNDLE_BIN
  || join(process.env.HOME || process.env.USERPROFILE || '.', '.openclaw-bundle', 'wrapper', 'openclaw')

async function runBinary() {
  if (!process.env.OPENCLAW_BIN) fatal('OPENCLAW_RUNTIME=binary requires OPENCLAW_BIN.')
  await spawnAndProxy(process.env.OPENCLAW_BIN, CLI_ARGS)
}
async function runInstalled() {
  if (!commandAvailable('openclaw')) fatal('OPENCLAW_RUNTIME=installed requires openclaw on PATH.')
  await spawnAndProxy('openclaw', CLI_ARGS)
}
async function runBundle() {
  if (!existsSync(BUNDLE_BIN)) fatal('OPENCLAW_RUNTIME=bundle requires the enterprise bundle.')
  await spawnAndProxy(BUNDLE_BIN, CLI_ARGS)
}
async function runSource() {
  const dir = process.env.OPENCLAW_SOURCE_DIR
  if (!dir || !existsSync(join(dir, 'package.json'))) fatal('OPENCLAW_RUNTIME=source requires OPENCLAW_SOURCE_DIR.')
  if (!commandAvailable('corepack')) fatal('OpenClaw source mode requires corepack.')
  await spawnAndProxy('corepack', ['pnpm', 'openclaw', ...CLI_ARGS], { cwd: dir })
}
async function resolvePackageBinary(pkg, binaryName) {
  let stdout = ''
  const code = await spawnAndProxy('npx', ['--yes', '--package', pkg, '--', 'which', binaryName], {
    inheritStdio: false,
    onStdout: chunk => { stdout += chunk },
  })
  if (code !== 0) return ''
  return stdout.trim().split(/\r?\n/)[0] || ''
}

async function runPackage() {
  if (DESKTOP_INSTALLED_ONLY === '1') fatal('OpenClaw is not installed. Install OpenClaw first.')
  if (!commandAvailable('npx')) fatal('OpenClaw package mode requires npx.')
  const binary = await resolvePackageBinary(PKG, 'openclaw')
  if (!binary) fatal(`Failed to resolve ${PKG}.`)
  await spawnAndProxy(binary, CLI_ARGS)
}
async function runManaged() {
  if (!process.env.DASHSCOPE_API_KEY) fatal('Automatic OpenClaw setup requires DASHSCOPE_API_KEY.')
  if (!process.env.QWEN_AUDIO_AGENT_BACKEND_MODEL || MODEL === 'auto') {
    fatal('Automatic OpenClaw setup requires QWEN_AUDIO_AGENT_BACKEND_MODEL.')
  }
  await runPackage()
}

switch (RUNTIME) {
  case 'binary': await runBinary(); break
  case 'installed': await runInstalled(); break
  case 'bundle': await runBundle(); break
  case 'source': await runSource(); break
  case 'package': await runPackage(); break
  case 'auto': break
  default: fatal(`Unknown OPENCLAW_RUNTIME: ${RUNTIME}`)
}

if (RUNTIME === 'auto') {
  if (process.env.OPENCLAW_BIN) await runBinary()
  else if (process.env.OPENCLAW_SOURCE_DIR) await runSource()
  else if (existsSync(BUNDLE_BIN)) await runBundle()
  else if (commandAvailable('openclaw')) await runInstalled()
  else await runManaged()
}

process.exit(0)

// ── recursive dir copy (Windows capability sharing) ──────────────────────────

function copyDir(src, dst) {
  mkdirSync(dst, { recursive: true })
  for (const e of readdirSync(src)) {
    const s = join(src, e), d = join(dst, e)
    statSync(s).isDirectory() ? copyDir(s, d) : copyFileSync(s, d)
  }
}
