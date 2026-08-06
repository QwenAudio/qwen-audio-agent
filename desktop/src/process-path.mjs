import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve, win32 } from 'node:path'

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

function applyMissingPath(
  env,
  pathValue,
  existsImpl,
  { delimiter = ':', normalize = value => value } = {},
) {
  const current = (env.PATH || '').split(delimiter).filter(Boolean)
  const known = new Set(current.map(normalize))
  const missing = []
  for (const dir of pathValue.split(delimiter).filter(Boolean)) {
    const normalized = normalize(dir)
    if (known.has(normalized) || !existsImpl(dir)) continue
    known.add(normalized)
    missing.push(dir)
  }
  if (missing.length === 0) return false
  env.PATH = [...current, ...missing].join(delimiter)
  return true
}

export function windowsPathDirectories(env = process.env) {
  const home = env.USERPROFILE || env.HOME
  const directories = [
    env.QWEN_AUDIO_AGENT_NODE_PATH,
    win32.join(env.ProgramFiles || 'C:\\Program Files', 'nodejs'),
    win32.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'nodejs'),
    ...(env.LOCALAPPDATA
      ? [
          win32.join(env.LOCALAPPDATA, 'Programs', 'nodejs'),
          win32.join(env.LOCALAPPDATA, 'nvm'),
        ]
      : []),
    ...(env.APPDATA
      ? [
          win32.join(env.APPDATA, 'npm'),
          win32.join(env.APPDATA, 'nvm'),
        ]
      : []),
    ...(home
      ? [
          win32.join(home, 'AppData', 'Roaming', 'npm'),
          win32.join(home, 'AppData', 'Roaming', 'nvm'),
          win32.join(home, '.nvm'),
        ]
      : []),
    env.NVM_HOME,
    env.NVM_SYMLINK,
  ].filter(Boolean)
  return [...new Map(
    directories.map(dir => [win32.normalize(dir).toLowerCase(), dir]),
  ).values()]
}

// 扫描常见版本管理器的子目录，发现实际安装的 node.exe 路径。
// 用于 where 命令找不到 node/npm 时的兜底（如 fnm/Volta 不修改系统 PATH）。
function discoverNodeInstallations(env, existsImpl) {
  const found = []

  // fnm：扫描 %APPDATA%\fnm\node-versions 下的各个版本
  if (env.APPDATA) {
    const fnmVersions = win32.join(env.APPDATA, 'fnm', 'node-versions')
    if (existsImpl(fnmVersions)) {
      try {
        const versions = readdirSync(fnmVersions)
        for (const ver of versions) {
          const nodePath = win32.join(fnmVersions, ver, 'installation', 'node.exe')
          if (existsImpl(nodePath)) {
            found.push(win32.dirname(nodePath))
          }
        }
      } catch {
        // 目录读取失败，跳过
      }
    }
  }

  // Volta：扫描 %LOCALAPPDATA%\Volta\tools\image\node 下的各个版本
  if (env.LOCALAPPDATA) {
    const voltaNode = win32.join(env.LOCALAPPDATA, 'Volta', 'tools', 'image', 'node')
    if (existsImpl(voltaNode)) {
      try {
        const versions = readdirSync(voltaNode)
        for (const ver of versions) {
          const nodePath = win32.join(voltaNode, ver, 'node.exe')
          if (existsImpl(nodePath)) {
            found.push(win32.dirname(nodePath))
          }
        }
      } catch {
        // 目录读取失败，跳过
      }
    }
  }

  return [...new Set(found)]
}

// 从 Windows 注册表读取完整的系统 + 用户 PATH，弥补 Electron
// 启动时继承不全的问题。返回已展开环境变量的目录列表。
function getWindowsRegistryPath(spawnImpl, env = process.env) {
  const paths = []
  const expand = value => value.replace(/%([^%]+)%/g, (_, name) => (
    env[name] || process.env[name] || `%${name}%`
  ))
  const regQuery = (key) => {
    try {
      const result = spawnImpl('reg', [
        'query', key, '/v', 'Path',
      ], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
      const match = (result.stdout || '').match(
        /Path\s+REG(?:_EXPAND)?_SZ\s+(.+)/,
      )
      return match ? match[1].trim() : ''
    } catch {
      return ''
    }
  }
  const machinePath = regQuery(
    'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
  )
  if (machinePath) {
    paths.push(...machinePath.split(';').map(expand).filter(Boolean))
  }
  const userPath = regQuery('HKCU\\Environment')
  if (userPath) {
    paths.push(...userPath.split(';').map(expand).filter(Boolean))
  }
  return paths
}

// 在指定的 PATH 中搜索命令，返回第一个匹配的完整路径。
// 使用 cmd.exe /c where 而非 shell: true，彻底规避 Node.js 22 的
// DEP0190 警告（shell: true 时传参存在安全风险）。
function resolveWindowsCommand(command, pathDirs, spawnImpl) {
  const pathEnv = pathDirs.join(win32.delimiter)
  try {
    const result = spawnImpl('cmd.exe', ['/c', 'where', command], {
      env: { ...process.env, PATH: pathEnv },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    })
    if (result.status === 0 && result.stdout) {
      return result.stdout.trim().split(/\r?\n/)[0]
    }
  } catch {
    // ignore
  }
  return ''
}

function applyWindowsPath(env, existsImpl, spawnImpl) {
  // 1. 从注册表获取完整的系统 + 用户 PATH
  const registryPaths = getWindowsRegistryPath(spawnImpl, env)

  // 2. 合并所有可能的路径：继承 PATH + 注册表 PATH + 预设目录
  //    如果 PATH 条目本身是可执行文件路径（如 C:\tools\nodejs\npm.cmd），
  //    提取其所在目录而非直接使用文件路径，否则 where/node 子进程无法搜到该目录。
  const sourceDirs = (env.PATH || '').split(win32.delimiter).map(entry => {
    const trimmed = entry.trim()
    if (!trimmed) return ''
    const lower = trimmed.toLowerCase()
    if (lower.endsWith('.cmd') || lower.endsWith('.exe') || lower.endsWith('.bat')) {
      return win32.dirname(trimmed)
    }
    return trimmed
  }).filter(Boolean)
  const merged = [
    ...sourceDirs,
    ...registryPaths,
    ...windowsPathDirectories(env),
  ]
  const unique = [...new Set(merged)]

  // 3. 用 where 精确找到 node 和 npm
  const nodeExe = resolveWindowsCommand('node', unique, spawnImpl)
  const npmExe = resolveWindowsCommand('npm', unique, spawnImpl)

  // 4. 提取目录
  const extra = []
  if (nodeExe) {
    const dir = win32.dirname(nodeExe)
    if (existsImpl(dir)) extra.push(dir)
  }
  if (npmExe) {
    const dir = win32.dirname(npmExe)
    if (dir && !extra.some(d => (
      win32.normalize(d).toLowerCase() === win32.normalize(dir).toLowerCase()
    ))) {
      if (existsImpl(dir)) extra.push(dir)
    }
  }

  // 5. where 失败时：先扫描版本管理器目录，再回退到预设目录
  let effective = ''
  if (extra.length > 0) {
    effective = extra.join(win32.delimiter)
  } else {
    const discovered = discoverNodeInstallations(env, existsImpl)
    effective = discovered.length > 0
      ? discovered.join(win32.delimiter)
      : windowsPathDirectories(env).join(win32.delimiter)
  }

  return applyMissingPath(env, effective, existsImpl, {
    delimiter: win32.delimiter,
    normalize: value => win32.normalize(value).toLowerCase(),
  })
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
  if (platform === 'win32') return applyWindowsPath(env, existsImpl, spawnImpl)
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
  if (platform === 'win32') return applyWindowsPath(env, existsImpl, spawnImpl)
  const cache = cacheFile === undefined ? pathCacheFile(env) : cacheFile
  const shellPath = loginShellPath({ shell: env.SHELL, spawnImpl })
  if (shellPath && cache) writePathCache(cache, shellPath)
  const effective = shellPath
    || (cache ? readPathCache(cache) : '')
    || fallbackPathDirectories(env.HOME).join(':')
  return applyMissingPath(env, effective, existsImpl)
}
