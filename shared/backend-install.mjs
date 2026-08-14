// 后台 Agent 一键安装的单一事实源：安装规格（INSTALL_SPECS）、
// 安装能力查询（installSupport）与执行器（installBackend）。
// CLI（qwenaudio install）与桌面版（设置页"安装"按钮）共用同一份逻辑；
//  spawn / 确认 / 进度回调全部注入，保证纯数据可测。
//
// 版本策略：npm 包一律锁定版本（与 scripts/ 下 managed 启动脚本同一口径），
// 可通过各 packageEnv 环境变量覆盖。npm 上的 kimi-code / codebuddy /
// hermes-agent 等同名包均为第三方或占位包，严禁写入规格。

import { spawn, spawnSync } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { resolve, win32 } from 'node:path'
import { homedir } from 'node:os'
import { inspectBackendAuthentication } from './backend-auth-status.mjs'
import { backendDefinition } from './backend-catalog.mjs'
import {
  backendAuthenticationSupport,
  backendConfigurationSupport,
  backendLifecycleSpec,
  resolveBackendLifecycle,
} from './backend-lifecycle.mjs'
import { findExecutable, inspectBackendSetups } from './backend-setup.mjs'

function clean(value) {
  return String(value || '').trim()
}

function specSteps(id, platform) {
  const lifecycle = backendLifecycleSpec(id)
  const spec = lifecycle?.installation
  if (!spec) return { lifecycle, spec: null, steps: [] }
  return {
    lifecycle,
    spec,
    steps: spec.steps.filter(step => (
      !step.platforms || step.platforms.includes(platform)
    )),
  }
}

function stepPackage(step, env) {
  return clean(env[step.packageEnv]) || step.package
}

function stepDisplay(step, env) {
  if (step.kind === 'script') return step.command
  const registry = clean(step.registry)
  return `npm install -g${registry ? ` --registry=${registry}` : ''} ${
    stepPackage(step, env)
  }`
}

function npmStepArgs(step, env) {
  const registry = clean(step.registry)
  return [
    'install',
    '-g',
    ...(registry ? [`--registry=${registry}`] : []),
    stepPackage(step, env),
  ]
}

function stepTitle(step, index) {
  return step.label ? `步骤 ${index + 1}（${step.label}）` : `步骤 ${index + 1}`
}

// 兼容现有调用方；新代码应从 backend-lifecycle.mjs 使用生命周期能力。
export const authenticationSupport = backendAuthenticationSupport

function resolvedAuthentication(id, observed, options) {
  const action = backendAuthenticationSupport(id, options)
  const status = observed?.status || 'unknown'
  return {
    ...action,
    status,
    required: action.required && status === 'unauthenticated',
    actionAvailable: action.supported && status !== 'authenticated',
  }
}

async function observedAuthentication(item, id, {
  env,
  platform,
  inspectAuthentication,
}) {
  if (item?.authentication?.status) return item.authentication
  return inspectAuthentication(id, {
    command: item?.backend?.path,
    env,
    platform,
  })
}

// 查询某后台在当前平台是否支持一键安装。纯函数，不触碰环境，
// 供桌面版渲染行状态与 CLI 预检共用。
export function installSupport(id, {
  env = process.env,
  platform = process.platform,
} = {}) {
  const definition = backendDefinition(id)
  if (!definition) {
    return { supported: false, reason: `不支持的后台：${clean(id)}` }
  }
  const { spec, steps } = specSteps(definition.id, platform)
  if (!spec) {
    return {
      supported: false,
      reason: '通用 ACP 后台需自行安装，并通过 ACP_COMMAND 配置',
    }
  }
  if (!steps.length) {
    return {
      supported: false,
      reason: spec.manualHints?.[platform] || '当前平台暂不支持一键安装',
    }
  }
  return {
    supported: true,
    requiresConfirmation: steps.some(step => step.kind === 'script'),
    authentication: backendAuthenticationSupport(definition.id, {
      env,
      platform,
    }),
    steps: steps.map((step, index) => ({
      kind: step.kind,
      title: stepTitle(step, index),
      display: stepDisplay(step, env),
    })),
  }
}

// 在检测报告上附加每个后台的安装能力，供桌面版渲染层使用
//（渲染层无法访问 Node 环境，不能自己 import 本模块）。
export function withBackendLifecycle(report, {
  env = process.env,
  platform = process.platform,
} = {}) {
  return {
    ...report,
    backends: (report?.backends || []).map(item => {
      const definition = backendDefinition(item.id)
      const authentication = resolvedAuthentication(
        item.id,
        item.authentication,
        { env, platform },
      )
      const install = installSupport(item.id, { env, platform })
      return {
        ...item,
        install,
        authentication,
        ...(definition?.supportsExternalService
          ? {
              externalService: {
                supported: true,
                defaultBaseUrl: definition.defaultBaseUrl || '',
                credential: Boolean(
                  definition.externalService?.credentialEnvironment,
                ),
              },
            }
          : {}),
        lifecycle: resolveBackendLifecycle(item, {
          installation: install,
          configuration: backendConfigurationSupport(item.id),
          authentication,
        }),
      }
    }),
  }
}

// 兼容旧名称，避免外部导入方在版本升级时立即失效。
export const withInstallSupport = withBackendLifecycle

// 构建 npm 子进程的运行环境。从 npmCommand 提取所在目录，确保 node.exe
// 也在 PATH 中（npm 的 postinstall 等钩子会启动 node 子进程）。
function npmRunEnv(baseEnv, npmCommand) {
  const env = { ...baseEnv, npm_config_yes: 'true' }
  if (!npmCommand) return env

  const npmDir = win32.dirname(npmCommand)
  const currentPath = env.PATH || ''

  // 剔除 PATH 中直接包含可执行文件名的异常条目（如 C:\tools\nodejs\npm.cmd），
  // 用正确的目录替代。
  const cleaned = currentPath.split(';').map(entry => {
    const trimmed = entry.trim()
    if (!trimmed) return ''
    // 如果条目以 .cmd / .exe 结尾（文件路径），替换为 npm 所在目录
    const lower = trimmed.toLowerCase()
    if (lower.endsWith('.cmd') || lower.endsWith('.exe') || lower.endsWith('.bat')) {
      return ''
    }
    return trimmed
  }).filter(Boolean)

  // 确保 npm 所在目录在最前面
  const dirPath = [npmDir, ...cleaned.filter(d => d !== npmDir)].join(';')
  env.PATH = dirPath
  return env
}

function runStep(command, args, {
  env,
  spawnImpl,
  onOutput,
}) {
  return new Promise(resolvePromise => {
    let child
    const outputChunks = []
    try {
      child = spawnImpl(command, args, {
        env: { ...env },
        windowsHide: true,
        shell: process.platform === 'win32',
      })
    } catch (error) {
      resolvePromise({ code: -1, error })
      return
    }
    let settled = false
    const finish = result => {
      if (settled) return
      settled = true
      result.output = outputChunks.join('')
      resolvePromise(result)
    }
    child.stdout?.on('data', chunk => {
      outputChunks.push(`[stdout] ${String(chunk)}`)
      onOutput('stdout', chunk)
    })
    child.stderr?.on('data', chunk => {
      outputChunks.push(`[stderr] ${String(chunk)}`)
      onOutput('stderr', chunk)
    })
    child.once('error', error => finish({ code: -1, error }))
    child.once('close', code => finish({ code: code ?? -1 }))
  })
}

// 调用方可能返回全量报告（如桌面版的整体重检），按 id 定位目标后台。
function reportItem(report, id) {
  return report?.backends?.find(entry => entry.id === id)
    || report?.backends?.[0]
    || null
}

// 某些组件在检测报告中已就绪。报告缺少组件级细节时
// 保守起见不跳过（执行全部步骤）。
function stepComponentReady(step, item) {
  if (!item || typeof item !== 'object') return false
  const component = step.component === 'adapter' ? item.adapter : item.backend
  if (!component || typeof component !== 'object') return false
  return component.ready === true
}

// 通过 PowerShell 的 Get-Command 定位 npm.cmd。
// 传入 searchPath 作为 PowerShell 进程的 PATH，确保 powershell.exe 自身可被找到。
function findNpmWithPowerShell(searchPath) {
  try {
    const psEnv = { ...process.env, PATH: searchPath || process.env.PATH }
    const result = spawnSync('powershell.exe', [
      '-Command',
      'Get-Command npm -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source',
    ], { env: psEnv, encoding: 'utf8', windowsHide: true, timeout: 8000 })
    if (result.status === 0 && result.stdout) {
      const path = result.stdout.trim().split(/\r?\n/)[0]
      if (path) return path
    }
  } catch {
    return ''
  }
}

// 在 PATH 中直接搜索 npm.cmd，不依赖 findExecutable。
// 处理 PATH 条目本身就是目标文件的情况（如 C:\tools\nodejs\npm.cmd）。
function findNpmDirectly(searchPath) {
  if (!searchPath) return ''
  const targets = process.platform === 'win32' ? ['npm.cmd', 'npm'] : ['npm']
  for (const entry of searchPath.split(';')) {
    const trimmed = entry.trim()
    if (!trimmed) continue

    // 如果 PATH 条目本身以目标文件名结尾，直接使用它
    for (const target of targets) {
      if (trimmed.toLowerCase().endsWith(`\\${target}`)) {
        try {
          accessSync(trimmed, constants.F_OK)
          return trimmed
        } catch { /* skip */ }
      }
    }

    // 标准路径拼接：目录 + npm.cmd
    for (const target of targets) {
      const candidate = win32.join(trimmed, target)
      try {
        accessSync(candidate, constants.F_OK)
        return candidate
      } catch { /* skip */ }
    }
  }
  return ''
}

// 终极兜底：扫描硬编码常见目录 + PATH 中所有目录，检查 npm.cmd 是否存在。
function findNpmByScanningDirectories(searchPath) {
  const hardcoded = [
    'C:\\Program Files\\nodejs\\npm.cmd',
    'C:\\Program Files (x86)\\nodejs\\npm.cmd',
    `${process.env.LOCALAPPDATA || ''}\\Programs\\nodejs\\npm.cmd`,
    `${process.env.LOCALAPPDATA || ''}\\Volta\\npm.cmd`,
    `${process.env.APPDATA || ''}\\npm\\npm.cmd`,
    `${process.env.APPDATA || ''}\\nvm\\npm.cmd`,
    `${process.env.USERPROFILE || process.env.HOME || ''}\\AppData\\Roaming\\npm\\npm.cmd`,
    `${process.env.NVM_SYMLINK || ''}\\npm.cmd`,
  ].filter(Boolean)

  const candidates = [...hardcoded]
  // 也搜索 PATH 中的每个目录
  if (searchPath) {
    for (const entry of searchPath.split(';')) {
      const trimmed = entry.trim()
      if (!trimmed) continue
      // PATH 条目本身可能是目标文件
      if (trimmed.toLowerCase().endsWith('\\npm.cmd')) {
        candidates.push(trimmed)
      }
      // 标准：目录 + npm.cmd
      candidates.push(win32.join(trimmed, 'npm.cmd'))
    }
  }
  for (const candidate of [...new Set(candidates)]) {
    try {
      accessSync(candidate, constants.F_OK)
      return candidate
    } catch { /* skip */ }
  }
  return ''
}

// 执行某后台的一键安装：先检测一次，只补齐缺失的组件（例如 Codex 本体
// 已装、仅缺 ACP 适配器时跳过本体步骤）；逐步运行安装命令（script 步骤
// 先经 confirmStep 确认），全部成功后重新检测该后台的可用状态。
// 返回 { ok, report?, loginHint?, alreadyInstalled?, error? }；
// error.code 取值：UNSUPPORTED / NPM_MISSING / DECLINED / STEP_FAILED /
// VERIFY_FAILED。
export async function installBackend(id, {
  env = process.env,
  platform = process.platform,
  spawnImpl = spawn,
  find = command => findExecutable(command, { env, platform }),
  confirmStep = async () => false,
  onProgress = () => {},
  inspect = async options => inspectBackendSetups(options),
  inspectAuthentication = inspectBackendAuthentication,
} = {}) {
  const support = installSupport(id, { env, platform })
  if (!support.supported) {
    return {
      ok: false,
      error: { code: 'UNSUPPORTED', message: support.reason },
    }
  }
  const definition = backendDefinition(id)
  const { steps } = specSteps(definition.id, platform)

  // 归一化 PATH 键名（Windows 上 process.env 可能使用 Path 而非 PATH）
  const resolvedEnv = env.PATH
    ? env
    : { ...env, PATH: process.env.PATH || env.Path || '' }

  const before = await inspect({ env: resolvedEnv, platform, backend: definition.id })
  const beforeItem = reportItem(before, definition.id)
  const pending = steps.filter(step => !stepComponentReady(step, beforeItem))
  if (!pending.length && beforeItem?.ready === true) {
    const observed = await observedAuthentication(beforeItem, definition.id, {
      env: resolvedEnv,
      platform,
      inspectAuthentication,
    })
    const authentication = resolvedAuthentication(
      definition.id,
      observed,
      { env: resolvedEnv, platform },
    )
    return {
      ok: true,
      report: before,
      loginHint: backendLifecycleSpec(definition.id).authentication?.hint,
      authentication,
      alreadyInstalled: true,
    }
  }

  // 通过注入的 find 定位 npm（默认 findExecutable，测试可替换）。
  // Windows 上 PATH 条目格式异常时 findExecutable 可能找不到，追加兜底。
  let npmCommand = ''
  if (pending.some(step => step.kind === 'npm')) {
    npmCommand = find(platform === 'win32' ? 'npm.cmd' : 'npm') || find('npm')

    if (!npmCommand && platform === 'win32') {
      const searchPath = resolvedEnv.PATH || ''
      npmCommand = findNpmDirectly(searchPath)
        || findNpmWithPowerShell(searchPath)
        || findNpmByScanningDirectories(searchPath)
    }

    if (!npmCommand) {
      return {
        ok: false,
        error: {
          code: 'NPM_MISSING',
          message: '未找到 npm，请先安装 Node.js（自带 npm）后重试',
        },
      }
    }
  }

  for (const [index, step] of steps.entries()) {
    const display = stepDisplay(step, env)
    if (!pending.includes(step)) {
      onProgress({
        step: index,
        phase: 'skip',
        title: stepTitle(step, index),
        display,
      })
      continue
    }
    onProgress({
      step: index,
      phase: 'start',
      title: stepTitle(step, index),
      display,
    })
    if (step.kind === 'script') {
      const confirmed = await confirmStep({
        index,
        display,
        command: step.command,
      })
      if (!confirmed) {
        return {
          ok: false,
          error: { code: 'DECLINED', message: '已取消安装' },
        }
      }
    }
    const result = step.kind === 'npm'
      ? await runStep(npmCommand, npmStepArgs(step, env), {
        env: npmRunEnv(resolvedEnv, npmCommand),
        spawnImpl,
        onOutput: (stream, chunk) => onProgress({
          step: index,
          phase: 'output',
          stream,
          chunk: String(chunk),
        }),
      })
      : platform === 'win32'
        ? await runStep('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-Command', step.command], {
          env: resolvedEnv,
          spawnImpl,
          onOutput: (stream, chunk) => onProgress({
            step: index,
            phase: 'output',
            stream,
            chunk: String(chunk),
          }),
        })
        : await runStep('/bin/sh', ['-c', step.command], {
          env: resolvedEnv,
          spawnImpl,
          onOutput: (stream, chunk) => onProgress({
            step: index,
            phase: 'output',
            stream,
            chunk: String(chunk),
          }),
        })
    if (result.code !== 0) {
      const outputTail = (result.output || '').trimEnd()
      return {
        ok: false,
        error: {
          code: 'STEP_FAILED',
          message: `安装命令执行失败（退出码 ${result.code}）：${display}`,
          exitCode: result.code,
          cause: result.error?.message || outputTail || '',
        },
      }
    }
    if (step.kind === 'npm' && npmCommand) {
      // npm install -g 成功后，把全局 bin 目录加入 resolvedEnv.PATH，
      // 否则后续验证步骤找不到刚安装的二进制。
      const prefixResult = spawnSync(npmCommand, ['config', 'get', 'prefix'], {
        env: npmRunEnv(resolvedEnv, npmCommand),
        encoding: 'utf8',
      })
      const rawPrefix = (prefixResult.stdout || '').trim()
      const npmGlobalBin = rawPrefix
        ? platform === 'win32'
          ? resolve(rawPrefix, '')
          : resolve(rawPrefix, 'bin')
        : platform === 'win32'
          ? resolve(homedir(), 'AppData', 'Roaming', 'npm')
          : '/usr/local/bin'
      const sep = platform === 'win32' ? ';' : ':'
      resolvedEnv.PATH = [npmGlobalBin, resolvedEnv.PATH].filter(Boolean).join(sep)
    }
    onProgress({ step: index, phase: 'done', title: stepTitle(step, index) })
  }

  const report = await inspect({ env: resolvedEnv, platform, backend: definition.id })
  const item = reportItem(report, definition.id)
  if (!item || item.ready !== true) {
    return {
      ok: false,
      report,
      error: {
        code: 'VERIFY_FAILED',
        message: item?.issues?.[0]
          || '安装已完成，但检测仍不可用；请新开终端确认命令可用后重试',
      },
    }
  }
  const observed = await observedAuthentication(item, definition.id, {
    env,
    platform,
    inspectAuthentication,
  })
  const authentication = resolvedAuthentication(
    definition.id,
    observed,
    { env, platform },
  )
  return {
    ok: true,
    report,
    loginHint: backendLifecycleSpec(definition.id).authentication?.hint,
    authentication,
  }
}
