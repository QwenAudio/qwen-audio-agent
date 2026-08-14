import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g
const MAX_OUTPUT = 256 * 1024

const STATUS_SPECS = {
  opencode: {
    args: ['auth', 'list'],
    parse(output) {
      const count = output.match(/(\d+)\s+credentials?/i)?.[1]
      return count === undefined ? 'unknown' : Number(count) > 0
        ? 'authenticated'
        : 'unauthenticated'
    },
  },
  qoder: {
    args: ['status'],
    parse(output) {
      if (/^(?:Username|Email):\s*\S+/im.test(output)) return 'authenticated'
      return /not (?:logged in|authenticated)|please (?:log in|login|sign in)/i.test(output)
        ? 'unauthenticated'
        : 'unknown'
    },
  },
  codex: {
    args: ['login', 'status'],
    parse(output) {
      if (/logged in/i.test(output) && !/not logged in/i.test(output)) {
        return 'authenticated'
      }
      return /not logged in|not authenticated/i.test(output)
        ? 'unauthenticated'
        : 'unknown'
    },
  },
}

function cleanOutput(value) {
  return String(value || '').replace(ANSI_PATTERN, '').trim()
}

async function codeBuddyCredentialFiles({
  env,
  platform,
  readdirImpl = readdir,
}) {
  const home = String(env.HOME || env.USERPROFILE || '').trim()
  if (!home && !env.LOCALAPPDATA && !env.XDG_DATA_HOME) return []
  const directory = platform === 'win32'
    ? join(
        String(env.LOCALAPPDATA || join(home, 'AppData', 'Local')),
        'CodeBuddyExtension', 'Data', 'Public', 'auth',
      )
    : platform === 'darwin'
      ? join(
          home, 'Library', 'Application Support',
          'CodeBuddyExtension', 'Data', 'Public', 'auth',
        )
      : join(
          String(env.XDG_DATA_HOME || join(home, '.local', 'share')),
          'CodeBuddyExtension', 'Data', 'Public', 'auth',
        )
  try {
    return await readdirImpl(directory, { recursive: true })
  } catch {
    return []
  }
}

function openClawInitializationStatus({ env, pathExists = existsSync }) {
  const home = String(env.HOME || env.USERPROFILE || '').trim()
  const stateDirectory = String(
    env.OPENCLAW_STATE_DIR || (home ? join(home, '.openclaw') : ''),
  ).trim()
  const configPath = String(
    env.OPENCLAW_CONFIG_PATH
    || (stateDirectory ? join(stateDirectory, 'openclaw.json') : ''),
  ).trim()
  const modelPath = stateDirectory
    ? join(stateDirectory, 'agents', 'main', 'agent', 'models.json')
    : ''
  if (!configPath || !modelPath) return 'unknown'
  const configured = pathExists(configPath)
  const hasModel = pathExists(modelPath)
  if (configured && hasModel) return 'authenticated'
  if (!configured && !hasModel) return 'unauthenticated'
  return 'unknown'
}

async function deepSeekCredentialStatus({ env, readFileImpl = readFile }) {
  if (String(env.DEEPSEEK_API_KEY || '').trim()) return 'authenticated'
  const home = String(env.DSH_HOME || env.HOME || env.USERPROFILE || '').trim()
  if (!home) return 'unauthenticated'
  const path = env.DSH_HOME
    ? join(home, '.credentials.yaml')
    : join(home, '.dsh', '.credentials.yaml')
  try {
    const content = await readFileImpl(path, 'utf8')
    return /^\s*DEEPSEEK_API_KEY\s*:\s*(?!(?:["']{2})\s*$)\S+/m.test(content)
      ? 'authenticated'
      : 'unauthenticated'
  } catch {
    return 'unauthenticated'
  }
}

function runStatus(command, args, {
  env,
  spawnImpl = spawn,
  timeoutMs = 8_000,
} = {}) {
  return new Promise(resolve => {
    let output = ''
    let settled = false
    let child
    let timer
    const finish = result => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ...result, output: cleanOutput(output) })
    }
    try {
      child = spawnImpl(command, args, {
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      })
    } catch (error) {
      resolve({ ok: false, output: '', error })
      return
    }
    const append = chunk => {
      if (output.length < MAX_OUTPUT) output += chunk
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    child.once('error', error => finish({ ok: false, error }))
    child.once('close', code => finish({ ok: code === 0, code }))
    timer = setTimeout(() => {
      child.kill?.()
      finish({ ok: false, timeout: true })
    }, timeoutMs)
    timer.unref?.()
  })
}

// 认证属于各后台自身，并非 ACP 的一部分。这里只执行官方、只读的状态
// 检测；无法确认时必须保留 unknown，不能把检测失败当成“未登录”。
export async function inspectBackendAuthentication(id, {
  command,
  env = process.env,
  platform = process.platform,
  run = runStatus,
  listCodeBuddyCredentials = codeBuddyCredentialFiles,
  pathExists = existsSync,
  readCredentialFile = readFile,
} = {}) {
  if (id === 'deepseek') {
    return {
      status: await deepSeekCredentialStatus({
        env,
        readFileImpl: readCredentialFile,
      }),
    }
  }
  if (id === 'codebuddy') {
    const files = await listCodeBuddyCredentials({ env, platform })
    // CodeBuddy 没有只读的 login status 命令。凭证目录为空可以确认未登录，
    // 但文件存在也可能只是过期或卸载后残留，不能据此宣称已登录。
    return { status: files.length ? 'unknown' : 'unauthenticated' }
  }
  if (id === 'openclaw') {
    return { status: openClawInitializationStatus({ env, pathExists }) }
  }
  const spec = STATUS_SPECS[id]
  if (!spec || !command) return { status: 'unknown' }
  const result = await run(command, spec.args, { env })
  return { status: spec.parse(cleanOutput(result.output)) }
}
