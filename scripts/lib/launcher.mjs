// Self-contained launcher utilities used by scripts/launcher .mjs files.
// These scripts live in extraResources (outside the asar archive) so they
// cannot import from shared/.  The findExecutable implementation below is
// kept in sync with shared/backend-setup.mjs.
import { accessSync, constants } from 'node:fs'
import { delimiter, extname, isAbsolute, resolve } from 'node:path'
import { spawn } from 'node:child_process'

// ── cross-platform executable resolution ─────────────────────────────────────

function clean(value) {
  return String(value || '').trim()
}

function expandHome(value, env) {
  if (value === '~') return clean(env.HOME || env.USERPROFILE) || value
  if (!value.startsWith('~/') && !value.startsWith('~\\')) return value
  const home = clean(env.HOME || env.USERPROFILE)
  return home ? resolve(home, value.slice(2)) : value
}

function executableExtensions(platform, env) {
  if (platform !== 'win32') return ['']
  return clean(env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter(Boolean)
    .map(v => v.toLowerCase())
}

function executableFile(path, platform) {
  try {
    accessSync(path, platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Find an executable on PATH.  Mirrors shared/backend-setup.mjs
 * findExecutable — keep the two implementations in sync.
 */
export function findExecutable(command, {
  env = process.env,
  platform = process.platform,
} = {}) {
  const value = expandHome(clean(command), env)
  if (!value) return ''
  const extensions = executableExtensions(platform, env)
  const hasPath = isAbsolute(value) || /[/\\]/.test(value)
  const directories = hasPath
    ? ['']
    : clean(env.PATH).split(delimiter).filter(Boolean)
  const suffixes = platform === 'win32' && !extname(value)
    ? [...extensions, '']
    : ['']
  for (const directory of directories) {
    for (const suffix of suffixes) {
      const candidate = directory
        ? resolve(directory, `${value}${suffix}`)
        : resolve(`${value}${suffix}`)
      if (executableFile(candidate, platform)) return candidate
    }
  }
  return ''
}

// ── env file loading (only needed when caller hasn't set ENV_LOADED=1) ───────

export function loadDotEnv(root) {
  if (process.env.QWEN_AUDIO_AGENT_ENV_LOADED === '1') return
  const candidates = [
    resolve(root, '.env.local'),
    resolve(root, '.env'),
  ]
  for (const file of candidates) {
    try {
      accessSync(file, constants.R_OK)
      process.loadEnvFile(file)
      process.env.QWEN_AUDIO_AGENT_ENV_LOADED = '1'
      break
    } catch {
      // file does not exist or cannot be read
    }
  }
}

// ── command availability ─────────────────────────────────────────────────────

export function commandAvailable(command, {
  env = process.env,
  platform = process.platform,
} = {}) {
  return Boolean(findExecutable(command, { env, platform }))
}

// ── spawn + proxy (inherits stdio, forwards signals, propagates exit code) ───

const CMD_META_CHARS = /([()%!^<>&|])/g

function escapeCmdValue(value) {
  return String(value).replace(CMD_META_CHARS, '^$1')
}

function quoteCmdArgument(value) {
  const quoted = escapeCmdValue(value)
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\*)$/g, '$1$1')
  return `"${quoted}"`
}

function quoteCmdCommand(value) {
  return `"${escapeCmdValue(value).replace(/"/g, '""')}"`
}

export function spawnAndProxy(command, args = [], {
  env = undefined,
  cwd = undefined,
  inheritStdio = true,
  platform = process.platform,
  spawnImpl = spawn,
  find = findExecutable,
  onStdout = undefined,
} = {}) {
  const childEnv = env ?? process.env
  const resolved = find(command, { env: childEnv, platform }) || command
  const extension = extname(resolved).toLowerCase()
  const useCmd = platform === 'win32' && ['.cmd', '.bat'].includes(extension)
  let executable = resolved
  let childArgs = args
  let windowsVerbatimArguments = false

  if (useCmd) {
    executable = childEnv.ComSpec || childEnv.COMSPEC
      || find('cmd.exe', { env: childEnv, platform }) || 'cmd.exe'
    const commandLine = [quoteCmdCommand(resolved), ...args.map(quoteCmdArgument)].join(' ')
    childArgs = ['/d', '/s', '/c', `"${commandLine}"`]
    windowsVerbatimArguments = true
  }

  return new Promise((resolvePromise) => {
    let settled = false
    let child
    const signals = ['SIGTERM', 'SIGINT', 'SIGHUP']
    const onProcessExit = () => {
      try { child?.kill() } catch { /* best-effort */ }
    }
    const signalHandlers = new Map(signals.map(signal => [signal, () => {
      try { child?.kill(signal) } catch { /* best-effort */ }
    }]))
    const cleanup = () => {
      process.removeListener('exit', onProcessExit)
      for (const [signal, handler] of signalHandlers) {
        process.removeListener(signal, handler)
      }
    }
    const finish = code => {
      if (settled) return
      settled = true
      cleanup()
      resolvePromise(code)
    }

    try {
      child = spawnImpl(executable, childArgs, {
        cwd,
        env: childEnv,
        stdio: inheritStdio ? 'inherit' : 'pipe',
        windowsVerbatimArguments,
      })
    } catch {
      finish(1)
      return
    }

    process.once('exit', onProcessExit)
    for (const [signal, handler] of signalHandlers) {
      process.on(signal, handler)
    }
    if (!inheritStdio && onStdout) child.stdout?.on('data', onStdout)
    child.once('error', () => finish(1))
    child.once('exit', (code, signal) => finish(signal ? 1 : (code ?? 1)))
  })
}
