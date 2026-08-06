// Claude Code ACP adapter launcher (node module — cross-platform).
// Replaces scripts/claude-code-acp shell script.
import { spawnAndProxy, commandAvailable, findExecutable } from './lib/launcher.mjs'

const RUNTIME = process.env.CLAUDE_CODE_ACP_RUNTIME || 'auto'
const PKG = process.env.CLAUDE_CODE_ACP_PACKAGE || '@zed-industries/claude-code-acp@0.16.2'
const DESKTOP_INSTALLED_ONLY = process.env.QWEN_AUDIO_AGENT_DESKTOP_INSTALLED_ONLY
const ARGS = process.argv.slice(2)

function fatal(msg) { console.error(msg); process.exit(1) }

// Copy CLAUDE_API_KEY → ANTHROPIC_API_KEY (upstream script convention)
if (!process.env.ANTHROPIC_API_KEY && process.env.CLAUDE_API_KEY) {
  process.env.ANTHROPIC_API_KEY = process.env.CLAUDE_API_KEY
}

// Ensure Claude Code parent CLI is available
if (!process.env.CLAUDE_CODE_EXECUTABLE) {
  if (commandAvailable('claude')) {
    process.env.CLAUDE_CODE_EXECUTABLE = findExecutable('claude')
  } else {
    fatal('Claude Code is not installed. Install Claude Code or set CLAUDE_CODE_EXECUTABLE.')
  }
}

async function runBinary() {
  const bin = process.env.CLAUDE_CODE_ACP_BIN || 'claude-code-acp'
  await spawnAndProxy(bin, ARGS)
}

async function runPackage() {
  if (DESKTOP_INSTALLED_ONLY === '1') {
    fatal('claude-code-acp is not installed. Install it before selecting Claude Code.')
  }
  if (!commandAvailable('npx')) fatal('Claude Code ACP package mode requires npx.')
  await spawnAndProxy('npx', ['-y', PKG, ...ARGS])
}

switch (RUNTIME) {
  case 'binary': await runBinary(); break
  case 'package': await runPackage(); break
  case 'auto':
    if (process.env.CLAUDE_CODE_ACP_BIN) {
      await runBinary()
    } else if (commandAvailable('claude-code-acp')) {
      await spawnAndProxy('claude-code-acp', ARGS)
    } else {
      await runPackage()
    }
    break
  default: fatal(`Unknown CLAUDE_CODE_ACP_RUNTIME: ${RUNTIME}`)
}

process.exit(0)
