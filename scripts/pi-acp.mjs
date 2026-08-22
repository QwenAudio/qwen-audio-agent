// Pi ACP adapter launcher (node module — cross-platform).
// Mirrors scripts/codex-acp.mjs for the community pi-acp adapter.
import { spawnAndProxy, commandAvailable, findExecutable } from './lib/launcher.mjs'

const RUNTIME = process.env.PI_ACP_RUNTIME || 'auto'
const PKG = process.env.PI_ACP_PACKAGE || 'pi-acp@0.0.33'
const DESKTOP_INSTALLED_ONLY = process.env.QWEN_AUDIO_AGENT_DESKTOP_INSTALLED_ONLY
const ARGS = process.argv.slice(2)

function fatal(msg) { console.error(msg); process.exit(1) }

// pi-acp reads PI_ACP_PI_COMMAND. Respect that adapter-native override first,
// then the qwen-audio-agent PI_BIN alias, and only then discover Pi on PATH.
const piCommand = process.env.PI_ACP_PI_COMMAND
  || process.env.PI_BIN
  || (commandAvailable('pi') ? findExecutable('pi') : '')
if (!piCommand) {
  fatal('Pi is not installed. Install Pi or set PI_ACP_PI_COMMAND / PI_BIN.')
}
if (!process.env.PI_BIN) process.env.PI_BIN = piCommand
if (!process.env.PI_ACP_PI_COMMAND) process.env.PI_ACP_PI_COMMAND = piCommand

async function runBinary() {
  const bin = process.env.PI_ACP_BIN || 'pi-acp'
  await spawnAndProxy(bin, ARGS)
}

async function runPackage() {
  if (DESKTOP_INSTALLED_ONLY === '1') {
    fatal('pi-acp is not installed. Install it before selecting Pi.')
  }
  if (!commandAvailable('npx')) fatal('Pi ACP package mode requires npx.')
  await spawnAndProxy('npx', ['-y', PKG, ...ARGS])
}

switch (RUNTIME) {
  case 'binary': await runBinary(); break
  case 'package': await runPackage(); break
  case 'auto':
    if (process.env.PI_ACP_BIN) {
      await runBinary()
    } else if (commandAvailable('pi-acp')) {
      await spawnAndProxy('pi-acp', ARGS)
    } else {
      await runPackage()
    }
    break
  default: fatal(`Unknown PI_ACP_RUNTIME: ${RUNTIME}`)
}

process.exit(0)
