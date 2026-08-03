import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import {
  backendDefinition,
  backendNames,
  normalizeBackendProtocol,
} from '../../shared/backend-catalog.mjs'
import {
  loadRuntimeEnvironment,
  requireRealtimeFrontendConfiguration,
} from '../../shared/runtime-environment.mjs'
import {
  normalizeRealtimeProvider,
  resolveRealtimeFrontendConfiguration,
} from '../../shared/realtime-provider-catalog.mjs'
import {
  readGatewayHealth,
} from '../../shared/gateway-client.mjs'
import {
  findRunningGateway,
} from '../../shared/gateway-instance-lock.mjs'

export {
  readGatewayHealth,
} from '../../shared/gateway-client.mjs'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

export function isLocalGateway(baseUrl) {
  return LOOPBACK_HOSTS.has(new URL(baseUrl).hostname)
}

function normalizedOrigin(value) {
  return new URL(value).origin
}

export function resolveBackend(options = {}, env = process.env) {
  const protocol = normalizeBackendProtocol(
    options.backend || env.AGENT_PROTOCOL,
  )
  if (!protocol) {
    return {
      enabled: false,
      protocol: null,
      ownership: null,
      permissionMode: null,
      agentId: '',
      baseUrl: null,
    }
  }
  const definition = backendDefinition(protocol)
  if (!definition) throw new Error(
    `不支持的后台 Agent：${protocol}（可选 ${backendNames().join('、')}）`,
  )
  const ownership = 'owned'
  const permissionMode = String(
    options.backendPermissionMode
    || env.QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE
    || 'native',
  ).toLowerCase()
  if (!['native', 'full'].includes(permissionMode)) {
    throw new Error(`不支持的后台权限模式：${permissionMode}`)
  }
  if (permissionMode === 'full' && ownership !== 'owned') {
    throw new Error('最高权限模式只支持由 Gateway 启动的后台 Agent')
  }
  if (permissionMode === 'full' && !definition.supportsFullPermission) {
    throw new Error(`${definition.label} 不支持 Gateway 统一最高权限模式`)
  }
  const configured = definition.baseUrlEnvironment
    ? env[definition.baseUrlEnvironment] || definition.defaultBaseUrl
    : ''
  return {
    protocol,
    ownership,
    permissionMode,
    agentId: String(
      options.backendAgent || env.QWEN_AUDIO_AGENT_BACKEND_AGENT || '',
    ).trim(),
    baseUrl: definition.baseUrlEnvironment
      ? normalizedOrigin(options.backendUrl || configured)
      : null,
  }
}

export function assertGatewayCompatibility(health, backend) {
  const actualEnabled = health?.backend?.enabled !== false
  if (!backend.protocol) {
    if (!actualEnabled) return
    const actualProtocol = health?.backend?.kind || health?.backend?.protocol
    throw new Error(
      `现有 Gateway 使用 ${actualProtocol || '后台 Agent'}，`
      + '与当前仅前台聊天配置不一致',
    )
  }
  const actualProtocol = health?.backend?.kind || health?.backend?.protocol
  const actualBaseUrl = health?.backend?.baseUrl
  const actualOwnership = health?.backend?.ownership
    || (health?.backend?.mode === 'compatible' ? 'external' : 'owned')
  const actualPermissionMode = health?.backend?.permissionMode || 'native'
  if (
    !actualProtocol
    || !backendDefinition(actualProtocol)
    || (
      backendDefinition(actualProtocol).baseUrlEnvironment
      && !actualBaseUrl
    )
  ) {
    throw new Error('现有 Gateway 未报告完整的后台 Agent 配置，无法安全复用')
  }
  if (
    actualProtocol !== backend.protocol
    || (
      backendDefinition(backend.protocol).baseUrlEnvironment
      && backend.ownership === 'external'
      && normalizedOrigin(actualBaseUrl) !== backend.baseUrl
    )
  ) {
    throw new Error(
      `现有 Gateway 使用 ${actualProtocol} (${actualBaseUrl})，`
      + `与当前配置 ${backend.protocol} (${backend.baseUrl}) 不一致`,
    )
  }
  if (
    actualOwnership
    && backend.ownership
    && actualOwnership !== backend.ownership
  ) {
    throw new Error(
      `现有 Gateway 的后台进程归属为 ${actualOwnership}，`
      + `与当前配置 ${backend.ownership} 不一致`,
    )
  }
  if (actualPermissionMode !== backend.permissionMode) {
    throw new Error(
      `现有 Gateway 使用 ${actualPermissionMode} 权限模式，`
      + `与当前配置 ${backend.permissionMode} 权限模式不一致`,
    )
  }
}

export function assertRealtimeGatewayCompatibility(health, env = process.env) {
  const expected = resolveRealtimeFrontendConfiguration(env)
  if (!String(health?.realtimeProvider || '').trim()) {
    throw new Error(
      '现有 Gateway 未报告完整的 Realtime 前台配置，无法安全复用',
    )
  }
  let actualProvider
  try {
    actualProvider = normalizeRealtimeProvider(health?.realtimeProvider)
  } catch {
    throw new Error(
      '现有 Gateway 未报告完整的 Realtime 前台配置，无法安全复用',
    )
  }
  const actualSignature = String(
    health?.realtimeConfigurationSignature || '',
  ).trim()
  if (!actualSignature) {
    throw new Error(
      '现有 Gateway 未报告完整的 Realtime 前台配置，无法安全复用',
    )
  }
  if (
    actualProvider !== expected.provider
    || actualSignature !== expected.signature
  ) {
    const mismatch = actualProvider !== expected.provider
      ? `现有 Gateway 使用 ${actualProvider} Realtime 前台，与当前配置 ${expected.provider} 不一致`
      : `现有 Gateway 的 ${expected.provider} Realtime 前台参数与当前配置不一致`
    throw new Error(`${mismatch}；请关闭旧 Gateway 后重试`)
  }
  return expected
}

export async function waitForGateway(baseUrl, {
  fetchImpl = fetch,
  requireBackend = false,
  timeoutMs = 45000,
  intervalMs = 200,
} = {}) {
  const deadline = Date.now() + timeoutMs
  let lastHealth = null
  while (Date.now() < deadline) {
    const health = await readGatewayHealth(baseUrl, fetchImpl)
    if (health) lastHealth = health
    if (health && (!requireBackend || health.backend?.ok === true)) {
      return health
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  const backendError = String(lastHealth?.backend?.error || '').trim()
  throw new Error(
    requireBackend
      ? `后台 Agent 启动超时：${baseUrl}${
        backendError ? `（${backendError.slice(0, 1000)}）` : ''
      }`
      : `Gateway 启动超时：${baseUrl}`,
  )
}

function waitForReadiness(child, readiness, label) {
  return new Promise((resolve, reject) => {
    const onExit = (code, signal) => {
      cleanup()
      reject(new Error(`${label} 在就绪前退出：${code ?? signal ?? 'unknown'}`))
    }
    const onError = error => {
      cleanup()
      reject(error)
    }
    const cleanup = () => {
      child.off('exit', onExit)
      child.off('error', onError)
    }
    child.once('exit', onExit)
    child.once('error', onError)
    readiness.then(value => {
      cleanup()
      resolve(value)
    }, error => {
      cleanup()
      reject(error)
    })
  })
}

function backendEnvironment(env, backend) {
  if (!backend.protocol) {
    const next = {
      ...env,
      // An empty value is an intentional override. Deleting it would let the
      // child Gateway reload AGENT_PROTOCOL from config.env.
      AGENT_PROTOCOL: '',
    }
    delete next.QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE
    delete next.QWEN_AUDIO_AGENT_BACKEND_AGENT
    return next
  }
  const definition = backendDefinition(backend.protocol)
  const next = {
    ...env,
    AGENT_PROTOCOL: backend.protocol,
    QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE: backend.permissionMode,
    ...(backend.agentId
      ? { QWEN_AUDIO_AGENT_BACKEND_AGENT: backend.agentId }
      : {}),
  }
  if (!definition?.baseUrlEnvironment) return next
  const target = new URL(backend.baseUrl)
  next[definition.baseUrlEnvironment] = backend.baseUrl
  const portEnvironment = definition.baseUrlEnvironment.replace(
    /_BASE_URL$/,
    '_PORT',
  )
  next[portEnvironment] = target.port
    || (target.protocol === 'https:' ? '443' : '80')
  return next
}

function gatewaySpawn(root, platform, env, target, options) {
  return {
    command: process.execPath,
    args: [resolve(root, 'server/src/index.mjs')],
    options: {
      cwd: resolve(root, 'server'),
      env: {
        ...env,
        // The desktop launcher runs inside Electron, so process.execPath points
        // at Electron rather than Node. Run the Gateway as a Node process to
        // prevent it from registering a second macOS Dock application.
        ELECTRON_RUN_AS_NODE: '1',
        HOST: options.listenHost
          || (target.hostname === 'localhost' ? '127.0.0.1' : target.hostname),
        PORT: String(options.listenPort || target.port || '80'),
      },
      detached: platform !== 'win32',
      // Keep a private IPC channel so the Gateway can detect an npm/CLI
      // launcher that disappears before its JavaScript signal handlers run.
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    },
  }
}

export class ManagedRuntime {
  constructor(children = [], {
    platform = process.platform,
    killImpl = process.kill,
  } = {}) {
    this.children = children
    this.platform = platform
    this.killImpl = killImpl
  }

  get ownsProcesses() {
    return this.children.length > 0
  }

  close(signal = 'SIGTERM') {
    for (const child of this.children) {
      if (child.exitCode == null && child.signalCode == null) {
        if (this.platform !== 'win32' && Number.isInteger(child.pid)) {
          try {
            // Managed services are spawned as process-group leaders. Signalling
            // the group also stops package-manager and backend descendants.
            this.killImpl(-child.pid, signal)
            continue
          } catch {
            // Fall back to the direct child if it exited between the checks.
          }
        }
        child.kill(signal)
      }
    }
  }

  async closeUnlessShared(
    baseUrl,
    signal = 'SIGTERM',
    fetchImpl = fetch,
  ) {
    if (!this.ownsProcesses) return false
    const health = await readGatewayHealth(baseUrl, fetchImpl)
    if ((health?.voiceClients?.byType?.desktop || 0) > 0) return false
    this.close(signal)
    return true
  }

  wait() {
    if (!this.children.length) return Promise.resolve(0)
    return Promise.race(this.children.map(child => (
      new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', (code, signal) => {
          if (signal === 'SIGINT' || signal === 'SIGTERM') resolve(0)
          else resolve(code ?? 1)
        })
      })
    ))).finally(() => this.close())
  }
}

export async function ensureRuntime(options, {
  root,
  env = process.env,
  fetchImpl = fetch,
  spawnImpl = spawn,
  platform = process.platform,
  loadEnvironment = () => loadRuntimeEnvironment({ root, env }),
  requireCredential = () => requireRealtimeFrontendConfiguration(env),
} = {}) {
  const runtimeEnvironment = loadEnvironment()
  const runtime = new ManagedRuntime([], { platform })
  const local = isLocalGateway(options.url)
  const backend = resolveBackend(options, env)
  const backendLabel = backend.protocol
    ? backendDefinition(backend.protocol)?.label || backend.protocol
    : '后台 Agent'
  let health = await readGatewayHealth(options.url, fetchImpl)
  if (!health && local && runtimeEnvironment?.configDirectory) {
    const active = await findRunningGateway(
      runtimeEnvironment.configDirectory,
      {
        readHealth: origin => readGatewayHealth(origin, fetchImpl),
      },
    )
    if (active) {
      options.url = active.origin
      health = active.health
    }
  }
  let existingGateway = Boolean(health)

  try {
    if (!health) {
      if (!local) throw new Error(`无法连接远程 Gateway：${options.url}`)
      if (options.allowMissingCredential !== true) requireCredential()
      const target = new URL(options.url)
      if (target.protocol !== 'http:') {
        throw new Error('本地自动启动 Gateway 只支持 http 地址')
      }
      Object.assign(env, backendEnvironment(env, backend))
      const spec = gatewaySpawn(
        root,
        platform,
        backendEnvironment(env, backend),
        target,
        options,
      )
      const gateway = spawnImpl(spec.command, spec.args, spec.options)
      runtime.children.push(gateway)
      try {
        health = await waitForReadiness(
          gateway,
          waitForGateway(options.url, {
            fetchImpl,
            requireBackend: Boolean(
              backend.protocol && options.waitForBackend !== false
            ),
          }),
          'Gateway',
        )
      } catch (startupError) {
        const winner = runtimeEnvironment?.configDirectory
          ? await findRunningGateway(runtimeEnvironment.configDirectory, {
              readHealth: origin => readGatewayHealth(origin, fetchImpl),
              timeoutMs: 3000,
            })
          : null
        if (!winner) throw startupError
        runtime.children = runtime.children.filter(child => child !== gateway)
        options.url = winner.origin
        health = winner.health
        existingGateway = true
      }
    }

    // An owned Gateway may move its private backend to a free local port.
    // Existing Gateways must still match the requested protocol and ownership.
    if (existingGateway || backend.ownership === 'external') {
      assertGatewayCompatibility(health, backend)
    } else {
      const actualProtocol = (
        health?.backend?.kind || health?.backend?.protocol || null
      )
      const actualEnabled = health?.backend?.enabled !== false
      if (
        actualProtocol !== backend.protocol
        || actualEnabled !== Boolean(backend.protocol)
      ) {
        throw new Error(
          `Gateway 启动了 ${actualProtocol || '仅前台聊天模式'}，`
          + `与当前配置 ${backend.protocol || '仅前台聊天模式'} 不一致`,
        )
      }
    }
    const realtime = local
      ? assertRealtimeGatewayCompatibility(health, env)
      : null
    if (
      health.voiceConfigured === false
      && options.allowMissingCredential !== true
    ) {
      throw new Error(
        realtime
          ? `现有 Gateway 的 ${realtime.label} Realtime 前台未配置完整；请修正配置后重启该 Gateway`
          : '远程 Gateway 的 Realtime 前台未配置完整',
      )
    }

    if (
      backend.protocol
      && health.backend?.ok !== true
      && options.waitForBackend !== false
    ) {
      throw new Error(
        backend.ownership === 'external'
          ? `未连接到已有 ${backendLabel} 后台服务，请先启动并检查 ${backend.baseUrl}`
          : `Gateway 启动的后台 Agent 未就绪：${health.backend?.baseUrl || backend.baseUrl}`,
      )
    }

    return runtime
  } catch (error) {
    runtime.close()
    throw error
  }
}
