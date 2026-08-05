// 后台 Agent 一键安装的单一事实源：安装规格（INSTALL_SPECS）、
// 安装能力查询（installSupport）与执行器（installBackend）。
// CLI（qwenaudio install）与桌面版（设置页"安装"按钮）共用同一份逻辑；
//  spawn / 确认 / 进度回调全部注入，保证纯数据可测。
//
// 版本策略：npm 包一律锁定版本（与 scripts/ 下 managed 启动脚本同一口径），
// 可通过各 packageEnv 环境变量覆盖。npm 上的 kimi-code / codebuddy /
// hermes-agent 等同名包均为第三方或占位包，严禁写入规格。

import { spawn } from 'node:child_process'
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
  return `npm install -g ${stepPackage(step, env)}`
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

function runStep(command, args, {
  env,
  spawnImpl,
  onOutput,
}) {
  return new Promise(resolvePromise => {
    let child
    try {
      child = spawnImpl(command, args, {
        env: { ...env },
        windowsHide: true,
      })
    } catch (error) {
      resolvePromise({ code: -1, error })
      return
    }
    let settled = false
    const finish = result => {
      if (settled) return
      settled = true
      resolvePromise(result)
    }
    child.stdout?.on('data', chunk => onOutput('stdout', chunk))
    child.stderr?.on('data', chunk => onOutput('stderr', chunk))
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

// 某安装步骤提供的组件在检测报告中是否已就绪。报告缺少组件级细节时
// 保守起见不跳过（执行全部步骤）。
function stepComponentReady(step, item) {
  if (!item || typeof item !== 'object') return false
  const component = step.component === 'adapter' ? item.adapter : item.backend
  if (!component || typeof component !== 'object') return false
  return component.ready === true
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

  const before = await inspect({ env, platform, backend: definition.id })
  const beforeItem = reportItem(before, definition.id)
  const pending = steps.filter(step => !stepComponentReady(step, beforeItem))
  if (!pending.length && beforeItem?.ready === true) {
    const observed = await observedAuthentication(beforeItem, definition.id, {
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
      report: before,
      loginHint: backendLifecycleSpec(definition.id).authentication?.hint,
      authentication,
      alreadyInstalled: true,
    }
  }

  let npmCommand = ''
  if (pending.some(step => step.kind === 'npm')) {
    npmCommand = find(platform === 'win32' ? 'npm.cmd' : 'npm') || find('npm')
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
      ? await runStep(npmCommand, ['install', '-g', stepPackage(step, env)], {
        env,
        spawnImpl,
        onOutput: (stream, chunk) => onProgress({
          step: index,
          phase: 'output',
          stream,
          chunk: String(chunk),
        }),
      })
      : await runStep('/bin/sh', ['-c', step.command], {
        env,
        spawnImpl,
        onOutput: (stream, chunk) => onProgress({
          step: index,
          phase: 'output',
          stream,
          chunk: String(chunk),
        }),
      })
    if (result.code !== 0) {
      return {
        ok: false,
        error: {
          code: 'STEP_FAILED',
          message: `安装命令执行失败（退出码 ${result.code}）：${display}`,
          exitCode: result.code,
          cause: result.error?.message || '',
        },
      }
    }
    onProgress({ step: index, phase: 'done', title: stepTitle(step, index) })
  }

  const report = await inspect({ env, platform, backend: definition.id })
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
