import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import readline from 'node:readline'
import { loadRuntimeEnvironment } from '../../shared/runtime-environment.mjs'
import { backendDefinition } from '../../shared/backend-catalog.mjs'
import {
  formatBackendSetup,
  inspectBackendSetups,
} from '../../shared/backend-setup.mjs'
import { installBackend } from '../../shared/backend-install.mjs'
import { helpText, parseArguments } from './arguments.mjs'
import {
  ensureRuntime,
  isLocalGateway,
  readGatewayHealth,
  waitForGateway,
} from './runtime.mjs'
import { launchWebUi } from './webui.mjs'
import { acquireCliInstance } from './instance-lock.mjs'
import { manageGatewayService } from './gateway-service.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const gatewayPath = resolve(root, 'server/src/index.mjs')

async function runMinimal(options) {
  const moduleUrl = pathToFileURL(resolve(root, 'tui/src/index.mjs'))
  const { runTui } = await import(moduleUrl)
  await runTui({
    url: options.url,
    sessionId: options.sessionId,
    audioMode: options.audioMode,
    takeover: options.takeover,
  })
  return 0
}

function applyGatewayOptions(env, options) {
  // Keep an explicit empty value so the environment loader cannot restore a
  // backend from config.env after --backend none selected frontend-only mode.
  env.AGENT_PROTOCOL = options.backend || ''
  const definition = backendDefinition(options.backend)
  if (options.backend) {
    env.QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE =
      options.backendPermissionMode
  } else {
    delete env.QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE
  }
  if (options.backend && options.backendAgent) {
    env.QWEN_AUDIO_AGENT_BACKEND_AGENT = options.backendAgent
  } else {
    delete env.QWEN_AUDIO_AGENT_BACKEND_AGENT
  }
  if (definition?.baseUrlEnvironment) {
    env[definition.baseUrlEnvironment] = options.backendUrl
  }
}

function gatewaySummary(health) {
  if (health?.backend?.enabled === false) return '仅前台聊天模式'
  const label = health?.backend?.label
    || health?.backend?.kind
    || health?.backend?.protocol
    || '后台 Agent'
  const state = health?.backend?.ok ? '已连接' : '未连接'
  return `${label} ${state}`
}

function gatewayServiceEnvironment(url) {
  const target = new URL(url)
  if (target.protocol !== 'http:' || !isLocalGateway(url)) {
    throw new Error('Gateway 后台服务只支持本机 HTTP 地址')
  }
  return {
    HOST: target.hostname.replace(/^\[(.*)\]$/, '$1'),
    PORT: target.port || '80',
  }
}

async function waitForGatewayStop(url, {
  inspectGateway = readGatewayHealth,
  timeoutMs = 15_000,
  intervalMs = 100,
} = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!await inspectGateway(url)) return
    await new Promise(resolvePromise => setTimeout(resolvePromise, intervalMs))
  }
  throw new Error(`Gateway 停止超时：${url}`)
}

function askConfirmation(question, { stdin, stdout }) {
  return new Promise(resolvePromise => {
    const rl = readline.createInterface({ input: stdin, output: stdout })
    rl.question(question, answer => {
      rl.close()
      resolvePromise(answer)
    })
  })
}

export async function main(argv, {
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
  signalSource = process,
  prepareEnvironment = ({ readOnly = false } = {}) => loadRuntimeEnvironment({
    root,
    env,
    readOnly,
  }),
  inspectSetups = options => inspectBackendSetups({
    env,
    backend: options.backendSpecified ? options.backend : '',
  }),
  runInstaller = (id, installerOptions) => installBackend(id, {
    env,
    ...installerOptions,
  }),
  runMinimalTui = runMinimal,
  prepareRuntime = options => ensureRuntime(options, { root, env }),
  inspectGateway = url => readGatewayHealth(url),
  manageService = (action, options) => manageGatewayService(action, options),
  waitForService = (url, { requireBackend = false } = {}) =>
    waitForGateway(url, { requireBackend }),
  waitForServiceStop = url => waitForGatewayStop(url, { inspectGateway }),
  runWebUi = options => launchWebUi(options),
  acquireInstance = directory => acquireCliInstance(directory),
} = {}) {
  const readOnlyCommand = ['setup', 'install'].includes(argv[0])
  const environment = prepareEnvironment({ readOnly: readOnlyCommand })
  const options = parseArguments(argv, env)
  if (options.help) {
    stdout.write(`${helpText()}\n`)
    return 0
  }
  if (options.command === 'config') {
    stdout.write(`${environment.configPath
      || resolve(environment.configDirectory, 'config.env')}\n`)
    return 0
  }
  if (options.command === 'setup') {
    const report = inspectSetups(options)
    stdout.write(options.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : `${formatBackendSetup(report)}\n`)
    const selected = report.backends.find(item => item.selected)
      || (options.backendSpecified ? report.backends[0] : null)
    return selected && !selected.ready ? 1 : 0
  }
  if (options.command === 'install') {
    const label = backendDefinition(options.installTarget)?.label
      || options.installTarget
    const confirmStep = options.yes
      ? async () => true
      : async step => {
          stdout.write(`即将执行官方安装脚本：\n  ${step.display}\n`)
          const answer = await askConfirmation('确认执行？[y/N] ', {
            stdin,
            stdout,
          })
          return /^y(?:es)?$/i.test(answer.trim())
        }
    const result = await runInstaller(options.installTarget, {
      confirmStep,
      onProgress: event => {
        if (event.phase === 'start') {
          stdout.write(`${event.title}：${event.display}\n`)
        } else if (event.phase === 'skip') {
          stdout.write(`${event.title}：组件已就绪，跳过\n`)
        } else if (event.phase === 'output') {
          stdout.write(event.chunk)
        }
      },
    })
    if (!result.ok) {
      stdout.write(
        `✗ ${label} 安装未完成：${result.error?.message || '未知错误'}\n`,
      )
      return 1
    }
    stdout.write(
      result.alreadyInstalled
        ? `✓ ${label} 已安装\n`
        : `✓ ${label} 安装完成\n`,
    )
    if (
      result.loginHint
      && result.authentication?.status !== 'authenticated'
    ) {
      stdout.write(`${result.loginHint}\n`)
    }
    return 0
  }

  if (
    (options.command === 'gateway' && options.gatewayAction !== 'run')
    || options.command === 'status'
  ) {
    const serviceEnvironment = [
      'install',
      'start',
      'restart',
    ].includes(options.gatewayAction)
      ? gatewayServiceEnvironment(options.url)
      : {}
    const serviceOptions = {
      configDirectory: environment.configDirectory,
      gatewayPath,
      serviceEnvironment,
      serviceMetadata: {
        url: options.url,
      },
    }
    if (options.gatewayAction === 'status') {
      const service = await manageService('status', serviceOptions)
      const serviceUrl = service.installedMetadata?.url || options.url
      const health = await inspectGateway(serviceUrl)
      stdout.write(
        `Gateway 后台服务：${
          service.running
            ? '运行中'
            : service.installed ? '已停止' : '未安装'
        }\n`
        + `连接状态：${health ? gatewaySummary(health) : '未连接'}\n`
        + `地址：${serviceUrl}\n`,
      )
      return service.running && health ? 0 : 1
    }

    const current = await manageService('status', serviceOptions)
    const currentUrl = current.installedMetadata?.url || options.url
    const health = await inspectGateway(currentUrl)
    if (
      ['install', 'start', 'restart'].includes(options.gatewayAction)
      && health
      && !current.running
    ) {
      throw new Error(
        'Gateway 正在前台运行；请先结束前台进程，再启动后台服务',
      )
    }
    const service = await manageService(
      options.gatewayAction,
      serviceOptions,
    )
    const serviceUrl = service.installedMetadata?.url || currentUrl
    if (['install', 'start', 'restart'].includes(options.gatewayAction)) {
      const ready = await waitForService(serviceUrl, {
        requireBackend: Boolean(options.backend),
      })
      stdout.write(
        `Gateway 后台服务已${
          options.gatewayAction === 'restart' ? '重启' : '启动'
        }：${serviceUrl}\n`
        + `${gatewaySummary(ready)}\n`,
      )
    } else {
      if (health && current.running) await waitForServiceStop(currentUrl)
      stdout.write(
        options.gatewayAction === 'uninstall'
          ? 'Gateway 后台服务已移除\n'
          : 'Gateway 后台服务已停止\n',
      )
    }
    if (service.logPath) stdout.write(`日志：${service.logPath}\n`)
    return 0
  }

  if (options.command === 'gateway') {
    applyGatewayOptions(env, options)
    let runtime
    let shutdownSignal
    const requestShutdown = signal => {
      shutdownSignal ||= signal
      runtime?.close(shutdownSignal)
    }
    const onSigint = () => requestShutdown('SIGINT')
    const onSigterm = () => requestShutdown('SIGTERM')
    // A terminal or SSH session closing sends SIGHUP rather than SIGINT.
    // The Gateway runs in its own process group, so it would otherwise outlive
    // this launcher and keep its ports occupied.
    const onSighup = () => requestShutdown('SIGTERM')
    // This is a final synchronous safeguard for unexpected launcher exits.
    // ManagedRuntime.close only sends signals, so it is safe in an exit hook.
    const onExit = () => runtime?.close('SIGTERM')
    signalSource.once('SIGINT', onSigint)
    signalSource.once('SIGTERM', onSigterm)
    signalSource.once('SIGHUP', onSighup)
    signalSource.once('exit', onExit)
    try {
      runtime = await prepareRuntime(options)
      if (shutdownSignal) {
        if (!runtime.ownsProcesses) return 0
        const stopped = runtime.wait()
        runtime.close(shutdownSignal)
        return await stopped
      }
      const health = await inspectGateway(options.url)
      stdout.write(
        `Gateway ${runtime.ownsProcesses ? '已启动' : '已在运行'}：${options.url}\n`
        + `WebUI：${options.url}/\n`
        + `${gatewaySummary(health)}\n`,
      )
      if (!runtime.ownsProcesses) return 0
      return await runtime.wait()
    } finally {
      signalSource.off('SIGINT', onSigint)
      signalSource.off('SIGTERM', onSigterm)
      signalSource.off('SIGHUP', onSighup)
      signalSource.off('exit', onExit)
      if (runtime?.ownsProcesses) runtime.close()
    }
  }

  const health = await inspectGateway(options.url)
  if (!health) {
    throw new Error(
      `Gateway 未运行：${options.url}。请先执行 qwenaudio gateway`,
    )
  }
  if (options.command === 'webui') return runWebUi(options)

  const instance = acquireInstance(environment.configDirectory)
  try {
    return await runMinimalTui(options)
  } finally {
    instance.release()
  }
}
