import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import {
  backendSkillsSpec,
  skillsInstallerAgents,
} from './backend-catalog.mjs'

// qwenaudio skill 是 skills.sh（npm 包 skills）的 1:1 品牌化入口：技能的
// 下载、落盘、lockfile 一致性全部由 skills.sh 自管，这里只负责组装参数、
// 透传输出。技能落点为各后台 CLI 的用户级全局目录（~/.claude/skills 等），
// 产品内外、桌面版与 CLI 天然共享。
const DEFAULT_SKILLS_CLI_PACKAGE = 'skills@1.5.22'

function clean(value) {
  return String(value || '').trim()
}

export function skillsCliPackage(env = process.env) {
  return clean(env.QWEN_AUDIO_AGENT_SKILLS_CLI_PACKAGE)
    || DEFAULT_SKILLS_CLI_PACKAGE
}

function defaultSpawn(args) {
  return spawnSync('npx', args, {
    encoding: 'utf8',
    windowsHide: true,
    // skills.sh 需要克隆仓库并按需下载，慢网络下留足时间。
    timeout: 600_000,
  })
}

export function runSkillsCli(args, {
  spawn = defaultSpawn,
  packageSpec = skillsCliPackage(),
} = {}) {
  const result = spawn(['-y', packageSpec, ...args])
  if (result.error) {
    throw new Error(`skills CLI 启动失败：${result.error.message}`)
  }
  if (result.status !== 0) {
    const detail = clean(result.stderr) || clean(result.stdout)
    throw new Error(`skills CLI 执行失败${detail ? `：\n${detail}` : ''}`)
  }
  return { stdout: String(result.stdout || ''), stderr: String(result.stderr || '') }
}

// 安装（或 --list 枚举）远程源里的技能。源形态与 skills.sh 完全对齐：
// owner/repo、GitHub/GitLab/任意 git URL、tree URL、技能页 URL、本地目录。
// agents 由调用方传入（通常为“已检测到的后台 ∪ 当前配置后台”），
// 缺省回退全名单。
export function addSkills(source, {
  skills = [],
  list = false,
  agents = skillsInstallerAgents(),
  spawn,
  packageSpec,
} = {}) {
  const target = clean(source)
  if (!target) throw new Error('请提供技能来源（owner/repo、git URL 或 hub 页面 URL）')
  if (list) {
    return runSkillsCli(['add', target, '--list'], { spawn, packageSpec })
  }
  if (!skills.length) {
    throw new Error(
      '请用 --skill 指定要安装的技能（可多次）；'
      + '先运行 --list 查看该来源提供的技能清单',
    )
  }
  return runSkillsCli([
    'add',
    target,
    ...skills.flatMap(name => ['--skill', clean(name)]),
    '-g',
    '--copy',
    '-y',
    ...agents.flatMap(agent => ['-a', agent]),
  ], { spawn, packageSpec })
}

export function listSkills({ spawn, packageSpec } = {}) {
  // 安装用 -g（全局），管理命令保持同一作用域。
  return runSkillsCli(['list', '-g'], { spawn, packageSpec })
}

export function removeSkill(name, { spawn, packageSpec } = {}) {
  const skill = clean(name)
  if (!skill) throw new Error('请提供要移除的技能名称')
  return runSkillsCli(['remove', skill, '-g', '-y'], { spawn, packageSpec })
}

export function updateSkills({ spawn, packageSpec } = {}) {
  return runSkillsCli(['update', '-g'], { spawn, packageSpec })
}

// skills.sh 的全局 lockfile：已装技能的唯一事实源（含来源仓库）。
const SKILL_LOCK_PATH = '.agents/.skill-lock.json'

// installer → 全局技能目录（相对用户主目录）。实测校准：codex/opencode/
// kimi 属 skills.sh 的 universal 组，不论是否单独安装都合并落在开放标准
// 目录 ~/.agents/skills（三家官方均声明读取该目录）。这是实现细节，
// 不进 catalog 协议。
const INSTALLER_SKILLS_DIRECTORIES = {
  'claude-code': '.claude/skills',
  codex: '.agents/skills',
  opencode: '.agents/skills',
  openclaw: '.openclaw/skills',
  qoder: '.qoder/skills',
  'qwen-code': '.qwen/skills',
  'kimi-code-cli': '.agents/skills',
  'hermes-agent': '.hermes/skills',
  codebuddy: '.codebuddy/skills',
  pi: '.pi/agent/skills',
}

export function readSkillLock({ homeDirectory = homedir() } = {}) {
  try {
    const parsed = JSON.parse(
      readFileSync(resolve(homeDirectory, SKILL_LOCK_PATH), 'utf8'),
    )
    return parsed?.skills && typeof parsed.skills === 'object'
      ? parsed.skills
      : {}
  } catch {
    return {}
  }
}

// 网关启动时的同步补装：把 lock 里已装的技能补齐到当前后台。日常路径
// 是纯本地 diff（毫秒级）；仅在确实缺失时才跑 skills.sh（秒级，一次性）。
// 同步执行保证后台进程首次扫描时技能已就位，无时序问题。
export function ensureBackendSkills({
  protocol,
  homeDirectory = homedir(),
  spawn,
  packageSpec,
} = {}) {
  const installer = backendSkillsSpec(protocol)?.installer
  if (!installer) return { refreshed: false, reason: 'no-installer' }
  const directory = INSTALLER_SKILLS_DIRECTORIES[installer]
  if (!directory) return { refreshed: false, reason: 'no-directory' }
  const locked = readSkillLock({ homeDirectory })
  const missing = Object.entries(locked).filter(([name]) => (
    !existsSync(resolve(homeDirectory, directory, name, 'SKILL.md'))
  ))
  if (!missing.length) return { refreshed: false, reason: 'up-to-date' }
  // 按来源仓库分组，一组一条命令。
  const bySource = new Map()
  for (const [name, entry] of missing) {
    const source = clean(entry?.source || entry?.sourceUrl)
    if (!source) continue
    if (!bySource.has(source)) bySource.set(source, [])
    bySource.get(source).push(name)
  }
  const installed = []
  const failures = []
  for (const [source, names] of bySource) {
    // 逐源容错：某个技能在上游已改名/删除（lock 过期）或网络失败时，
    // 不影响其它来源的补装；失败项给出 remove 清理指引。
    try {
      runSkillsCli([
        'add',
        source,
        ...names.flatMap(name => ['--skill', name]),
        '-g',
        '--copy',
        '-y',
        '-a',
        installer,
      ], { spawn, packageSpec })
      installed.push(...names)
    } catch (error) {
      failures.push({
        source,
        names,
        hint: '若技能已从来源移除，可执行 qwenaudio skill remove <名称> 清理，'
          + '避免每次启动重试',
        message: String(error?.message || error),
      })
    }
  }
  return {
    refreshed: installed.length > 0,
    installer,
    installed,
    failures,
  }
}

// 供 launcher 拼“本地实际存在的后台 ∪ 当前配置后台”名单：避免为用户
// 从未使用的后台预建目录；新后台出现后由启动补装自动补齐。
export function presentInstallerAgents({
  readyBackends = [],
  currentProtocol = '',
} = {}) {
  const installers = new Set()
  for (const id of [...readyBackends, currentProtocol]) {
    const installer = id ? backendSkillsSpec(id)?.installer : null
    if (installer) installers.add(installer)
  }
  // 一个都没有（纯前台模式且未装任何 CLI）时回退全名单，保持命令可用。
  return installers.size ? [...installers] : skillsInstallerAgents()
}
