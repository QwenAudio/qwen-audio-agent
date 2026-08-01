import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'

import { userConfigDirectory } from '../../shared/runtime-environment.mjs'

const PATH_MARK = 'QWEN_AUDIO_AGENT_PATH'

export function loginShellPath({
  shell,
  spawnImpl = spawnSync,
  timeoutMs = 3000,
} = {}) {
  if (!shell) return ''
  try {
    // -l 读取 login 配置（如 homebrew），-i 读取 interactive 配置
    // （nvm 等版本管理器通常在这里初始化）。用标记提取以容忍 shell
    // 启动脚本里的其他输出。
    const result = spawnImpl(
      shell,
      ['-l', '-i', '-c', `echo "${PATH_MARK}<<<$PATH>>>"`],
      { encoding: 'utf8', timeout: timeoutMs, windowsHide: true },
    )
    const match = String(result?.stdout || '').match(
      new RegExp(`${PATH_MARK}<<<([\\s\\S]*?)>>>`),
    )
    return match ? match[1].trim() : ''
  } catch {
    return ''
  }
}

export function fallbackPathDirectories(home) {
  return [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    ...(home ? [`${home}/.local/bin`] : []),
  ]
}

export function pathCacheFile(env = process.env) {
  return resolve(userConfigDirectory(env), 'login-shell-path.json')
}

export function readPathCache(file) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof data?.path === 'string' && data.path) return data.path
  } catch {
    // 缓存损坏时按无缓存处理，下次启动会重建。
  }
  return ''
}

function writePathCache(file, pathValue) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ path: pathValue }), 'utf8')
  } catch {
    // 缓存写失败只影响下次启动速度，不影响本次 PATH 扩充。
  }
}

function applyMissingPath(env, pathValue, existsImpl) {
  const current = (env.PATH || '').split(':').filter(Boolean)
  const missing = pathValue
    .split(':')
    .filter(Boolean)
    .filter(dir => !current.includes(dir) && existsImpl(dir))
  if (missing.length === 0) return false
  env.PATH = [...current, ...missing].join(':')
  return true
}

// 有缓存时后台异步重跑登录 shell 更新缓存，供下次启动使用；
// 失败静默——缓存只是提速手段。
function refreshPathCacheAsync({ shell, cacheFile, spawnImpl = spawn }) {
  if (!shell || !cacheFile) return
  try {
    const child = spawnImpl(
      shell,
      ['-l', '-i', '-c', `echo "${PATH_MARK}<<<$PATH>>>"`],
      { windowsHide: true },
    )
    let output = ''
    child.stdout?.on('data', chunk => {
      output += chunk
    })
    child.on('error', () => {})
    child.on('close', () => {
      const match = output.match(
        new RegExp(`${PATH_MARK}<<<([\\s\\S]*?)>>>`),
      )
      if (match?.[1]?.trim()) writePathCache(cacheFile, match[1].trim())
    })
  } catch {
    // ignore
  }
}

// 启动路径：优先读磁盘缓存（毫秒级），同时后台异步刷新缓存；
// 仅首次无缓存时同步执行登录 shell（一次性成本）。
// 登录 shell 全失败时回退到常见安装目录。
export function expandProcessPath({
  env = process.env,
  platform = process.platform,
  spawnImpl = spawnSync,
  existsImpl = existsSync,
  cacheFile,
} = {}) {
  if (platform === 'win32') return false
  const cache = cacheFile === undefined ? pathCacheFile(env) : cacheFile
  const cached = cache ? readPathCache(cache) : ''
  if (cached) {
    refreshPathCacheAsync({ shell: env.SHELL, cacheFile: cache })
    return applyMissingPath(env, cached, existsImpl)
  }
  const shellPath = loginShellPath({ shell: env.SHELL, spawnImpl })
  if (shellPath && cache) writePathCache(cache, shellPath)
  const effective = shellPath || fallbackPathDirectories(env.HOME).join(':')
  return applyMissingPath(env, effective, existsImpl)
}

// 主动刷新路径（设置页"刷新"检测前调用）：同步重读登录 shell，
// 保证刚安装的命令立即可见；失败时沿用缓存，永不回退。
export function refreshProcessPath({
  env = process.env,
  platform = process.platform,
  spawnImpl = spawnSync,
  existsImpl = existsSync,
  cacheFile,
} = {}) {
  if (platform === 'win32') return false
  const cache = cacheFile === undefined ? pathCacheFile(env) : cacheFile
  const shellPath = loginShellPath({ shell: env.SHELL, spawnImpl })
  if (shellPath && cache) writePathCache(cache, shellPath)
  const effective = shellPath
    || (cache ? readPathCache(cache) : '')
    || fallbackPathDirectories(env.HOME).join(':')
  return applyMissingPath(env, effective, existsImpl)
}
