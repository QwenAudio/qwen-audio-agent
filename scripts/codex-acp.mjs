// Codex ACP adapter launcher (node module — cross-platform).
// Replaces scripts/codex-acp shell script.
import { spawnAndProxy, commandAvailable, findExecutable } from './lib/launcher.mjs'

const RUNTIME = process.env.CODEX_ACP_RUNTIME || 'auto'
const PKG = process.env.CODEX_ACP_PACKAGE || '@agentclientprotocol/codex-acp@1.1.7'
const DESKTOP_INSTALLED_ONLY = process.env.QWEN_AUDIO_AGENT_DESKTOP_INSTALLED_ONLY
const ARGS = process.argv.slice(2)

function fatal(msg) { console.error(msg); process.exit(1) }

// Disable browser auto-open
process.env.NO_BROWSER = process.env.NO_BROWSER || '1'

// Ensure Codex parent CLI is available
if (!process.env.CODEX_PATH) {
  if (commandAvailable('codex')) {
    process.env.CODEX_PATH = findExecutable('codex')
  } else {
    fatal('Codex is not installed. Install Codex or set CODEX_PATH.')
  }
}

async function runBinary() {
  const bin = process.env.CODEX_ACP_BIN || 'codex-acp'
  await spawnAndProxy(bin, ARGS)
}

async function runPackage() {
  if (DESKTOP_INSTALLED_ONLY === '1') {
    fatal('codex-acp is not installed. Install it before selecting Codex.')
  }
  if (!commandAvailable('npx')) fatal('Codex ACP package mode requires npx.')
  await spawnAndProxy('npx', ['-y', PKG, ...ARGS])
}

switch (RUNTIME) {
  case 'binary': await runBinary(); break
  case 'package': await runPackage(); break
  case 'auto':
    if (process.env.CODEX_ACP_BIN) {
      await runBinary()
    } else if (commandAvailable('codex-acp')) {
      await spawnAndProxy('codex-acp', ARGS)
    } else {
      await runPackage()
    }
    break
  default: fatal(`Unknown CODEX_ACP_RUNTIME: ${RUNTIME}`)
}

process.exit(0)
