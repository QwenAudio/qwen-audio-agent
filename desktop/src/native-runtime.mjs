import { EventEmitter } from 'node:events'
import {
  chmodSync as nodeChmodSync,
  existsSync as nodeExistsSync,
  readFileSync as nodeReadFileSync,
  writeFileSync as nodeWriteFileSync,
} from 'node:fs'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { inspectBackendSetups as defaultInspectBackendSetups } from '../../shared/backend-setup.mjs'
import { readGatewayHealth as defaultReadGatewayHealth } from '../../shared/gateway-client.mjs'
import { findRunningGateway as defaultFindRunningGateway } from '../../shared/gateway-instance-lock.mjs'
import {
  loadRuntimeEnvironment,
  userConfigDirectory,
} from '../../shared/runtime-environment.mjs'
import {
  assertDesktopGatewayCompatibility as defaultAssertGatewayCompatibility,
  desktopGatewayEnvironment,
  EmbeddedGateway,
} from './gateway-process.mjs'
import { refreshProcessPath as defaultRefreshProcessPath } from './process-path.mjs'
import {
  parseSettings,
  realtimeSettingsConfigured,
  updateSettingsContent,
} from './settings-config.mjs'
import { isLoopbackUrl, validateAppUrl } from './security.mjs'

const BACKEND_REPORT_TTL_MS = 10 * 60 * 1000
const MAX_GATEWAY_CRASH_RESTARTS = 3

function gatewayPort(origin) {
  const port = Number(new URL(origin).port)
  return Number.isInteger(port) && port > 0 ? port : 3101
}

export function mapGatewayHealthToDesktopStatus(health) {
  return {
    gatewayConnected: Boolean(health),
    realtimeProvider: health?.realtimeProvider || null,
    realtimeLabel: health?.realtimeLabel || null,
    realtimeModel: health?.realtimeModel || null,
    voiceConfigured: health?.voiceConfigured === true,
    realtimeConnection: health?.voiceClients?.realtime || null,
    backend: health?.backend
      ? {
          protocol: health.backend.kind || health.backend.protocol || null,
          label: health.backend.label || null,
          baseUrl: health.backend.baseUrl || null,
          model: health.backend.model || null,
          connected: health.backend.ok === true,
          error: health.backend.error || null,
        }
      : null,
  }
}

export class NativeDesktopRuntime extends EventEmitter {
  constructor({
    runtimeRoot,
    sourceRoot,
    env = process.env,
    runtimeEnvironment = null,
    configExistedAtLaunch,
    readFileSync = nodeReadFileSync,
    writeFileSync = nodeWriteFileSync,
    chmodSync = nodeChmodSync,
    existsSync = nodeExistsSync,
    createGateway = options => new EmbeddedGateway(options),
    readGatewayHealth = defaultReadGatewayHealth,
    findRunningGateway = defaultFindRunningGateway,
    assertGatewayCompatibility = defaultAssertGatewayCompatibility,
    inspectBackendSetups = defaultInspectBackendSetups,
    refreshProcessPath = defaultRefreshProcessPath,
    logger = null,
    now = Date.now,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
  } = {}) {
    super()
    this.runtimeRoot = runtimeRoot
    this.sourceRoot = sourceRoot
    this.env = env
    this.readFileSync = readFileSync
    this.writeFileSync = writeFileSync
    this.chmodSync = chmodSync
    this.existsSync = existsSync
    this.createGateway = createGateway
    this.readGatewayHealth = readGatewayHealth
    this.findRunningGateway = findRunningGateway
    this.assertGatewayCompatibility = assertGatewayCompatibility
    this.inspectBackendSetups = inspectBackendSetups
    this.refreshProcessPath = refreshProcessPath
    this.logger = logger
    this.now = now
    this.setTimeoutImpl = setTimeoutImpl
    this.clearTimeoutImpl = clearTimeoutImpl

    const expectedConfigPath = resolve(userConfigDirectory(env), 'config.env')
    const existed = configExistedAtLaunch
      ?? existsSync(expectedConfigPath)
    this.runtimeEnvironment = runtimeEnvironment || loadRuntimeEnvironment({
      root: runtimeRoot,
      env,
      prepareBackendRuntime: false,
      generateSecret: false,
    })
    this.configExistedAtLaunch = existed
    this.initialSettings = this.readSettingsSync()
    this.configuredOrigin = validateAppUrl(this.initialSettings.gatewayUrl)
    this.origin = null
    this.gateway = null
    this.borrowedGatewayOrigin = ''
    this.gatewayCrashCount = 0
    this.gatewayRecoveryTimer = null
    this.backendReportCache = null
    this.setupRequired = (
      !existed
      || (
        isLoopbackUrl(this.configuredOrigin)
        && !realtimeSettingsConfigured(this.initialSettings)
      )
    )
    this.status = {
      state: this.setupRequired ? 'setup-required' : 'checking',
      reason: this.setupRequired ? 'settings-required' : null,
      canRepair: this.setupRequired,
      origin: null,
    }
  }

  readSettingsSync() {
    return parseSettings(
      this.readFileSync(this.runtimeEnvironment.configPath, 'utf8'),
      this.env,
    )
  }

  async readSettings() {
    return this.readSettingsSync()
  }

  subscribeStatus(listener) {
    if (typeof listener !== 'function') return () => {}
    this.on('status', listener)
    return () => this.off('status', listener)
  }

  async initialize() {
    this.#setStatus('checking')
    if (this.setupRequired) {
      this.origin = null
      return this.#setStatus('setup-required', {
        reason: 'settings-required',
        canRepair: true,
      })
    }
    return this.start(this.initialSettings)
  }

  async start(settings = this.readSettingsSync()) {
    const configuredOrigin = validateAppUrl(settings.gatewayUrl)
    this.configuredOrigin = configuredOrigin
    this.#setStatus('starting')
    if (isLoopbackUrl(configuredOrigin)) {
      this.origin = await this.#startLocalGateway(configuredOrigin)
      this.#setStatus('ready', { origin: this.origin })
    } else {
      if (this.gateway) {
        const gateway = this.gateway
        this.gateway = null
        gateway.onUnexpectedExit = null
        await gateway.stop()
      }
      this.borrowedGatewayOrigin = ''
      this.origin = configuredOrigin
      this.#setStatus('external', { origin: this.origin })
    }
    this.setupRequired = false
    this.env.QWEN_AUDIO_AGENT_URL = this.origin
    this.env.QWEN_AUDIO_ORB_STYLE = settings.orbStyle
    return this.status
  }

  async getRuntimeStatus(target = this.origin) {
    const health = target ? await this.readGatewayHealth(target) : null
    return mapGatewayHealthToDesktopStatus(health)
  }

  async inspectBackends({ force = false } = {}) {
    const now = this.now()
    if (
      !force
      && this.backendReportCache
      && now - this.backendReportCache.time < BACKEND_REPORT_TTL_MS
    ) return this.backendReportCache.report
    this.refreshProcessPath()
    const configured = this.existsSync(this.runtimeEnvironment.configPath)
      ? parseEnv(this.readFileSync(this.runtimeEnvironment.configPath, 'utf8'))
      : {}
    const report = this.inspectBackendSetups({
      env: {
        ...this.env,
        ...configured,
        QWEN_AUDIO_AGENT_DESKTOP_INSTALLED_ONLY: '1',
      },
    })
    const result = {
      selected: report.selected,
      backends: report.backends.map(item => ({
        id: item.id,
        label: item.label,
        ready: item.ready,
        selected: item.selected,
        issues: item.issues,
      })),
    }
    this.backendReportCache = { report: result, time: now }
    return result
  }

  async writeSettings(settings) {
    const current = this.readFileSync(this.runtimeEnvironment.configPath, 'utf8')
    const previous = parseSettings(current, this.env)
    const content = updateSettingsContent(current, settings)
    const normalized = parseSettings(content)
    const nextOrigin = validateAppUrl(normalized.gatewayUrl)
    const remote = !isLoopbackUrl(nextOrigin)
    if (!remote && !realtimeSettingsConfigured(normalized)) {
      throw new Error(normalized.realtimeProvider === 'dashscope'
        ? '请先填写 DashScope API Key'
        : '请先填写 Speech-to-Speech 服务地址')
    }
    if (remote) {
      const remoteRuntime = await this.getRuntimeStatus(nextOrigin)
      if (!remoteRuntime.gatewayConnected) {
        throw new Error(`无法连接 Gateway：${nextOrigin}`)
      }
    }
    const runtimeChanged = (
      nextOrigin !== this.configuredOrigin
      || previous.dashscopeApiKey !== normalized.dashscopeApiKey
      || previous.realtimeProvider !== normalized.realtimeProvider
      || previous.agentProtocol !== normalized.agentProtocol
      || previous.realtimeModel !== normalized.realtimeModel
      || previous.speechToSpeechRealtimeUrl
        !== normalized.speechToSpeechRealtimeUrl
      || previous.speechToSpeechAuthToken
        !== normalized.speechToSpeechAuthToken
      || previous.backendModel !== normalized.backendModel
    )
    const orbStyleChanged = previous.orbStyle !== normalized.orbStyle
    if (this.borrowedGatewayOrigin && runtimeChanged) {
      const borrowedHealth = await this.readGatewayHealth(
        this.borrowedGatewayOrigin,
      )
      if (borrowedHealth) {
        throw new Error(
          '当前正在复用由其他进程启动的 Gateway，请先停止该 Gateway 后再修改运行配置',
        )
      }
      this.borrowedGatewayOrigin = ''
    }
    this.writeFileSync(this.runtimeEnvironment.configPath, content, {
      encoding: 'utf8',
      mode: 0o600,
    })
    this.chmodSync(this.runtimeEnvironment.configPath, 0o600)
    this.logger?.info('settings.applied', {
      realtimeProvider: normalized.realtimeProvider,
      backend: normalized.agentProtocol,
      remoteGateway: remote,
      runtimeChanged,
      orbStyleChanged,
    })

    let restarted = false
    this.configuredOrigin = nextOrigin
    if (remote) {
      if (this.gateway) {
        const gateway = this.gateway
        this.gateway = null
        gateway.onUnexpectedExit = null
        await gateway.stop()
      }
      this.borrowedGatewayOrigin = ''
      this.origin = nextOrigin
      this.#setStatus('external', { origin: nextOrigin })
    } else if (this.gateway?.running && runtimeChanged) {
      this.#setStatus('starting')
      this.origin = await this.gateway.restart({
        preferredPort: gatewayPort(nextOrigin),
      })
      restarted = true
      this.#setStatus('ready', { origin: this.origin })
    } else if (!this.gateway?.running) {
      this.origin = await this.#startLocalGateway(nextOrigin)
      restarted = !this.borrowedGatewayOrigin
      this.#setStatus('ready', { origin: this.origin })
    }
    this.setupRequired = false
    this.env.QWEN_AUDIO_AGENT_URL = this.origin
    this.env.QWEN_AUDIO_ORB_STYLE = normalized.orbStyle
    const runtime = await this.getRuntimeStatus(this.origin)
    return {
      settings: normalized,
      restarted,
      restartRequired: false,
      orbStyleChanged,
      runtime,
    }
  }

  async restartRuntime() {
    if (!isLoopbackUrl(this.configuredOrigin)) {
      this.#setStatus('external', { origin: this.origin })
      return this.status
    }
    if (!this.gateway?.running) return this.start(this.readSettingsSync())
    this.#setStatus('starting')
    this.origin = await this.gateway.restart({
      preferredPort: gatewayPort(this.configuredOrigin),
    })
    this.env.QWEN_AUDIO_AGENT_URL = this.origin
    return this.#setStatus('ready', { origin: this.origin })
  }

  async stop() {
    this.#clearRecoveryTimer()
    this.#setStatus('stopping')
    const gateway = this.gateway
    this.gateway = null
    this.borrowedGatewayOrigin = ''
    if (gateway) {
      gateway.onUnexpectedExit = null
      await gateway.stop()
    }
    this.origin = null
  }

  async #startLocalGateway(origin) {
    if (this.gateway?.running) return this.gateway.start()
    const environment = this.#gatewayEnvironment()
    const active = await this.findRunningGateway(
      this.runtimeEnvironment.configDirectory,
      { readHealth: this.readGatewayHealth },
    )
    if (active) {
      this.assertGatewayCompatibility(active.health, environment)
      this.borrowedGatewayOrigin = active.origin
      this.logger?.info('gateway.reused', {
        origin: active.origin,
        instanceId: active.lease.instanceId,
        owner: active.lease.owner,
      })
      return active.origin
    }
    this.borrowedGatewayOrigin = ''
    if (!this.gateway) {
      const gateway = this.createGateway({
        preferredPort: gatewayPort(origin),
        envFactory: () => this.#gatewayEnvironment(),
        logger: this.logger?.child({ subsystem: 'embedded_gateway' }),
      })
      gateway.onUnexpectedExit = () => this.#handleUnexpectedExit(gateway)
      this.gateway = gateway
    }
    let started
    try {
      started = await this.gateway.start({
        preferredPort: gatewayPort(origin),
      })
    } catch (error) {
      const winner = await this.findRunningGateway(
        this.runtimeEnvironment.configDirectory,
        {
          readHealth: this.readGatewayHealth,
          timeoutMs: 3000,
        },
      )
      if (!winner) throw error
      this.assertGatewayCompatibility(winner.health, environment)
      this.gateway = null
      this.borrowedGatewayOrigin = winner.origin
      this.logger?.info('gateway.reused_after_race', {
        origin: winner.origin,
        instanceId: winner.lease.instanceId,
        owner: winner.lease.owner,
      })
      return winner.origin
    }
    this.borrowedGatewayOrigin = ''
    this.gatewayCrashCount = 0
    return started
  }

  #gatewayEnvironment() {
    const configured = parseEnv(
      this.readFileSync(this.runtimeEnvironment.configPath, 'utf8'),
    )
    return desktopGatewayEnvironment({
      env: this.env,
      configured,
      runtimeRoot: this.runtimeRoot,
      sourceRoot: this.sourceRoot,
    })
  }

  #handleUnexpectedExit(gateway) {
    if (this.gateway !== gateway) return
    this.origin = null
    if (this.gatewayCrashCount >= MAX_GATEWAY_CRASH_RESTARTS) {
      this.#setStatus('error', {
        reason: 'gateway-recovery-exhausted',
        canRepair: true,
      })
      return
    }
    this.gatewayCrashCount += 1
    this.#setStatus('recovering', {
      reason: 'gateway-exited',
      retry: this.gatewayCrashCount,
      delayMs: 1000,
    })
    this.gatewayRecoveryTimer = this.setTimeoutImpl(() => {
      this.gatewayRecoveryTimer = null
      if (this.gateway !== gateway || gateway.running) return
      gateway.start({
        preferredPort: gatewayPort(this.configuredOrigin),
      }).then(origin => {
        this.origin = origin
        this.env.QWEN_AUDIO_AGENT_URL = origin
        this.#setStatus('ready', { origin })
      }).catch(error => {
        this.logger?.error('gateway.restart_failed', { error })
        this.#setStatus('error', {
          reason: 'gateway-start-failed',
          canRepair: true,
        })
      })
    }, 1000)
  }

  #clearRecoveryTimer() {
    if (this.gatewayRecoveryTimer) {
      this.clearTimeoutImpl(this.gatewayRecoveryTimer)
      this.gatewayRecoveryTimer = null
    }
  }

  #setStatus(state, details = {}) {
    this.status = {
      state,
      reason: details.reason ?? null,
      canRepair: details.canRepair ?? false,
      origin: details.origin ?? this.origin,
      ...(details.retry !== undefined ? { retry: details.retry } : {}),
      ...(details.delayMs !== undefined ? { delayMs: details.delayMs } : {}),
    }
    this.emit('status', { ...this.status })
    return this.status
  }
}
