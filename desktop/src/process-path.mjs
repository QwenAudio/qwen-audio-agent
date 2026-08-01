import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

// macOS / Linux 图形界面应用的 PATH 只包含系统目录，找不到通过 Homebrew、
// nvm 或 Agent 官方安装脚本（如 ~/.kimi-code/bin）安装的命令。与终端保持
// 一致的唯一可靠方式是读取用户登录 shell 解析后的 PATH；失败时回退到
// 常见安装目录列表。

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

export function expandProcessPath({
  env = process.env,
  platform = process.platform,
  spawnImpl = spawnSync,
  existsImpl = existsSync,
} = {}) {
  if (platform === 'win32') return false
  const current = (env.PATH || '').split(':').filter(Boolean)
  const shellPath = loginShellPath({ shell: env.SHELL, spawnImpl })
  const candidates = shellPath
    ? shellPath.split(':').filter(Boolean)
    : fallbackPathDirectories(env.HOME)
  const missing = candidates.filter(
    dir => !current.includes(dir) && existsImpl(dir),
  )
  if (missing.length === 0) return false
  env.PATH = [...current, ...missing].join(':')
  return true
}
