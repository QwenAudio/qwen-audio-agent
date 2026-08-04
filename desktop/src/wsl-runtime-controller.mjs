import { spawn as nodeSpawn } from 'node:child_process'
import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFile as nodeReadFile } from 'node:fs/promises'
import { posix } from 'node:path'
import { readGatewayHealth as defaultReadGatewayHealth } from '../../shared/gateway-client.mjs'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../../shared/desktop-host-protocol.mjs'
import { DesktopHostClient } from './desktop-host-client.mjs'
import { mapGatewayHealthToDesktopStatus } from './native-runtime.mjs'
import {
  buildWslCommand,
  buildWslLoginCommand,
  convertWindowsPathToWsl,
  executeWslCommand,
  probeWslRuntime,
} from './wsl-discovery.mjs'
import {
  createCurrentRuntimeMarker,
  createWslRuntimeInstallPlan,
  createWslRuntimeLayout,
  createWslRuntimeMarker,
  runtimeSetupState,
} from './wsl-runtime-layout.mjs'

const SESSION_TOKEN_ENV = 'QWEN_AUDIO_DESKTOP_SESSION_TOKEN'
const CONFIRMATION_TTL_MS = 2 * 60_000
const SUPPORTED_ARCHITECTURES = new Set(['x86_64', 'amd64'])
const INSTALL_PROGRESS_PHASES = new Set([
  'preparing',
  'copying',
  'installing',
  'verifying',
])

const INSPECT_RUNTIME_SOURCE = [
  "const fs=require('node:fs');",
  "const read=p=>{try{return JSON.parse(fs.readFileSync(p,'utf8'))}catch{return null}};",
  'const [markerPath,currentPath,executablePath]=process.argv.slice(1);',
  'process.stdout.write(JSON.stringify({',
  'marker:read(markerPath),currentMarker:read(currentPath),',
  "executableExists:fs.existsSync(executablePath)})+'\\n');",
].join('')

const WRITE_JSON_ATOMIC_SOURCE = [
  "const fs=require('node:fs');",
  "const path=require('node:path');",
  'const [target,json]=process.argv.slice(1);',
  "const directory=path.dirname(target);fs.mkdirSync(directory,{recursive:true,mode:0o700});",
  "const temporary=path.join(directory,'.'+path.basename(target)+'.'+process.pid+'.tmp');",
  "fs.writeFileSync(temporary,json+'\\n',{mode:0o600});",
  'fs.renameSync(temporary,target);',
].join('')

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function resultStdout(result) {
  return result && typeof result === 'object' && 'stdout' in result
    ? result.stdout
    : result
}

function parseCommandJson(result, label) {
  try {
    return JSON.parse(Buffer.from(resultStdout(result) || '').toString('utf8'))
  } catch {
    throw new Error(`${label} returned invalid JSON`)
  }
}

function appendWslEnv(current, name) {
  const entries = String(current || '').split(':').filter(Boolean)
  if (!entries.some(entry => entry.split('/')[0] === name)) entries.push(name)
  return entries.join(':')
}

function fixedControllerMessage(reason) {
  const messages = {
    'wsl-unavailable': 'Windows Subsystem for Linux is unavailable',
    'wsl2-required': 'The selected distribution must use WSL2',
    'no-distributions': 'No user WSL distribution is available',
    'distribution-not-found': 'The selected WSL distribution is unavailable',
    'unsupported-architecture': 'The selected WSL architecture is unsupported',
    'node-required': 'Node.js and npm are required in the selected distribution',
    'runtime-required': 'The private WSL runtime must be installed or updated',
    'runtime-install-failed': 'The private WSL runtime installation failed',
    'runtime-integrity-failed': 'The bundled WSL runtime failed its integrity check',
    'runtime-verification-failed': 'The installed WSL runtime could not be verified',
    'bridge-handshake-failed': 'The Windows-to-WSL bridge handshake failed',
    'gateway-start-failed': 'The WSL Gateway could not be started',
    'gateway-health-timeout': 'Windows could not reach the WSL Gateway through localhost',
    'runtime-promotion-failed': 'The healthy WSL runtime could not be marked current',
    'bridge-recovery-exhausted': 'The Windows-to-WSL bridge stopped repeatedly',
    'external-invalid': 'External mode requires a loopback HTTP Gateway URL',
    'external-unavailable': 'The external loopback Gateway is unavailable',
    'confirmation-required': 'A fresh confirmation is required',
    'confirmation-expired': 'The confirmation has expired',
    'removal-target-changed': 'The private runtime removal target changed',
    'runtime-removal-failed': 'The private WSL runtime could not be removed',
    cancelled: 'The runtime setup was cancelled',
  }
  return messages[reason] || 'The Windows WSL runtime operation failed'
}

function canRepairReason(reason) {
  return !new Set([
    'unsupported-architecture',
    'node-required',
    'cancelled',
  ]).has(reason)
}

export class WslRuntimeControllerError extends Error {
  constructor(reason, options = {}) {
    super(fixedControllerMessage(reason), options)
    this.name = 'WslRuntimeControllerError'
    this.reason = reason
    this.canRepair = options.canRepair ?? canRepairReason(reason)
  }
}

function asControllerError(error, fallbackReason) {
  if (error instanceof WslRuntimeControllerError) return error
  const reason = typeof error?.reason === 'string'
    ? error.reason
    : fallbackReason
  return new WslRuntimeControllerError(reason)
}

function normalizeNodeVersion(value) {
  return String(value || '').trim().replace(/^v/, '')
}

function markerMatches(left, right) {
  return Boolean(left && right)
    && left.desktopVersion === right.desktopVersion
    && left.packageVersion === right.packageVersion
    && left.protocolVersion === right.protocolVersion
    && left.sha256 === right.sha256
}

function assertFixedPrivateRuntimeRoot(root) {
  const value = String(root || '')
  const suffix = '/.local/share/qwaudio/windows-client'
  if (
    !value.startsWith('/')
    || value === suffix
    || !value.endsWith(suffix)
    || posix.normalize(value) !== value
  ) throw new Error('Expected a fixed private runtime root')
  return value
}

function boundedProgress(value) {
  if (!value || !INSTALL_PROGRESS_PHASES.has(value.phase)) return null
  const completed = Number(value.completed)
  const total = Number(value.total)
  if (
    !Number.isSafeInteger(completed)
    || !Number.isSafeInteger(total)
    || completed < 0
    || total < 1
    || total > 10_000
    || completed > total
  ) return null
  return { phase: value.phase, completed, total }
}

export function validateExternalGatewayOrigin(value) {
  let url
  try {
    url = new URL(String(value || ''))
  } catch {
    throw new WslRuntimeControllerError('external-invalid')
  }
  if (
    url.protocol !== 'http:'
    || !['127.0.0.1', 'localhost'].includes(url.hostname)
    || !url.port
    || url.username
    || url.password
    || url.pathname !== '/'
    || url.search
    || url.hash
  ) {
    throw new WslRuntimeControllerError('external-invalid')
  }
  const port = Number(url.port)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new WslRuntimeControllerError('external-invalid')
  }
  return url.origin
}

function commandResultFailed(result) {
  return result?.code !== undefined && result.code !== 0
}

export class DefaultWslRuntimeAdapter {
  constructor({
    runCommand = executeWslCommand,
    spawnImpl = nodeSpawn,
    fetchImpl = fetch,
    env = process.env,
    randomBytes = nodeRandomBytes,
    readFile = nodeReadFile,
  } = {}) {
    this.runCommand = runCommand
    this.spawnImpl = spawnImpl
    this.fetchImpl = fetchImpl
    this.env = env
    this.randomBytes = randomBytes
    this.readFile = readFile
  }

  discover({ configured }) {
    return probeWslRuntime({ configured, runCommand: this.runCommand })
  }

  async #run(command, label) {
    let result
    try {
      result = await this.runCommand(command)
    } catch {
      throw new Error(`${label} failed`)
    }
    if (commandResultFailed(result)) throw new Error(`${label} failed`)
    return result
  }

  async inspectRuntime({ distribution, layout }) {
    const result = await this.#run(buildWslLoginCommand({
      distribution,
      executable: 'node',
      args: [
        '--eval',
        INSPECT_RUNTIME_SOURCE,
        layout.versionMarkerPath,
        layout.currentMarkerPath,
        layout.executablePath,
      ],
    }), 'Runtime inspection')
    const value = parseCommandJson(result, 'Runtime inspection')
    return {
      marker: value?.marker || null,
      currentMarker: value?.currentMarker || null,
      executableExists: value?.executableExists === true,
    }
  }

  async verifyRuntimePayload({ path, sha256 }) {
    const expected = String(sha256 || '').toLowerCase()
    if (!/^[a-f\d]{64}$/.test(expected)) return false
    try {
      const bytes = await this.readFile(path)
      const actual = createHash('sha256').update(bytes).digest('hex')
      return actual === expected
    } catch {
      return false
    }
  }

  async prepareInstallPlan(context) {
    const sourceWslPath = await convertWindowsPathToWsl({
      distribution: context.distribution,
      windowsPath: context.bundledTarballPath,
      runCommand: this.runCommand,
    })
    const sessionId = this.randomBytes(16).toString('hex')
    const sessionDirectory = posix.join(
      context.layout.privateRoot,
      'sessions',
      sessionId,
    )
    const stagedTarballPath = posix.join(sessionDirectory, 'runtime.tgz')
    const npmPlan = createWslRuntimeInstallPlan({
      distribution: context.distribution,
      layout: context.layout,
      bundledTarballWslPath: stagedTarballPath,
    })
    return {
      displayCommand: npmPlan.displayCommand,
      sourceWslPath,
      sessionDirectory,
      stagedTarballPath,
      npmCommand: npmPlan.command,
    }
  }

  async installRuntime(plan, { marker, distribution, layout, onProgress, signal }) {
    const active = () => {
      if (signal?.aborted) {
        const error = new Error('Runtime installation cancelled')
        error.name = 'AbortError'
        throw error
      }
    }
    active()
    onProgress({ phase: 'preparing', completed: 0, total: 4 })
    await this.#run(buildWslCommand({
      distribution,
      executable: 'mkdir',
      args: ['--parents', '--mode=700', plan.sessionDirectory],
    }), 'Runtime staging directory creation')
    try {
      active()
      onProgress({ phase: 'copying', completed: 1, total: 4 })
      await this.#run(buildWslCommand({
        distribution,
        executable: 'cp',
        args: ['--', plan.sourceWslPath, plan.stagedTarballPath],
      }), 'Runtime payload copy')
      active()
      onProgress({ phase: 'installing', completed: 2, total: 4 })
      await this.#run(plan.npmCommand, 'Runtime npm installation')
      active()
      onProgress({ phase: 'verifying', completed: 3, total: 4 })
      await this.#writeMarker({
        distribution,
        path: layout.versionMarkerPath,
        value: marker,
      })
      onProgress({ phase: 'verifying', completed: 4, total: 4 })
    } finally {
      await this.#run(buildWslCommand({
        distribution,
        executable: 'rm',
        args: ['--force', '--', plan.stagedTarballPath],
      }), 'Runtime staging cleanup').catch(() => {})
      await this.#run(buildWslCommand({
        distribution,
        executable: 'rmdir',
        args: ['--', plan.sessionDirectory],
      }), 'Runtime staging directory cleanup').catch(() => {})
    }
  }

  spawnHost({ distribution, runtimeEntry, sessionToken }) {
    const command = buildWslLoginCommand({
      distribution,
      executable: runtimeEntry,
      args: ['desktop-host'],
    })
    return this.spawnImpl(command.file, command.args, {
      ...command.options,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...this.env,
        [SESSION_TOKEN_ENV]: sessionToken,
        WSLENV: appendWslEnv(this.env.WSLENV, SESSION_TOKEN_ENV),
      },
    })
  }

  readGatewayHealth(origin) {
    return defaultReadGatewayHealth(origin, this.fetchImpl)
  }

  async promoteCurrent({ distribution, layout, currentMarker }) {
    await this.#writeMarker({
      distribution,
      path: layout.currentMarkerPath,
      value: currentMarker,
    })
  }

  async resolveLastKnownGood(context) {
    const current = context.inspect?.currentMarker
    if (
      !current
      || current.protocolVersion !== context.protocolVersion
      || typeof current.desktopVersion !== 'string'
    ) return null
    let layout
    try {
      layout = createWslRuntimeLayout({
        homeDirectory: context.probe.home,
        desktopVersion: current.desktopVersion,
      })
    } catch {
      return null
    }
    const inspect = await this.inspectRuntime({
      distribution: context.distribution,
      layout,
    })
    if (
      !inspect.executableExists
      || !inspect.marker
      || inspect.marker.protocolVersion !== context.protocolVersion
    ) return null
    return {
      marker: inspect.marker,
      runtimeEntry: layout.executablePath,
      layout,
    }
  }

  async validateRemovalTarget({ distribution, layout }) {
    assertFixedPrivateRuntimeRoot(layout?.privateRoot)
    const selectedInspect = await this.inspectRuntime({ distribution, layout })
    const current = selectedInspect.currentMarker
    if (!current || typeof current.desktopVersion !== 'string') {
      throw new Error('Private runtime marker is missing')
    }
    const currentLayout = createWslRuntimeLayout({
      homeDirectory: layout.homeDirectory,
      desktopVersion: current.desktopVersion,
    })
    const inspect = current.desktopVersion === posix.basename(layout.versionDirectory)
      ? selectedInspect
      : await this.inspectRuntime({ distribution, layout: currentLayout })
    if (
      !inspect.marker
      || !markerMatches(current, inspect.marker)
    ) {
      throw new Error('Private runtime marker is missing')
    }
    return {
      root: layout.privateRoot,
      marker: inspect.marker,
    }
  }

  async removePrivateRuntime({ distribution, root }) {
    const target = assertFixedPrivateRuntimeRoot(root)
    await this.#run(buildWslCommand({
      distribution,
      executable: 'rm',
      args: ['--recursive', '--force', '--', target],
    }), 'Private runtime removal')
  }

  #writeMarker({ distribution, path, value }) {
    return this.#run(buildWslLoginCommand({
      distribution,
      executable: 'node',
      args: ['--eval', WRITE_JSON_ATOMIC_SOURCE, path, JSON.stringify(value)],
    }), 'Runtime marker write')
  }
}

export class WslRuntimeController extends EventEmitter {
  constructor({
    desktopVersion,
    packageVersion,
    protocolVersion = DESKTOP_HOST_PROTOCOL_VERSION,
    runtimeSha256,
    bundledTarballPath,
    preferences,
    adapter = new DefaultWslRuntimeAdapter(),
    createClient = options => new DesktopHostClient(options),
    randomBytes = nodeRandomBytes,
    now = Date.now,
    healthTimeoutMs = 45_000,
    healthPollIntervalMs = 500,
    recoveryDelaysMs = [1_000, 2_000, 4_000],
    confirmationTtlMs = CONFIRMATION_TTL_MS,
  } = {}) {
    super()
    this.desktopVersion = desktopVersion
    this.packageVersion = packageVersion
    this.protocolVersion = protocolVersion
    this.runtimeSha256 = runtimeSha256
    this.bundledTarballPath = bundledTarballPath
    this.preferences = preferences
    this.adapter = adapter
    this.createClient = createClient
    this.randomBytes = randomBytes
    this.now = now
    this.healthTimeoutMs = healthTimeoutMs
    this.healthPollIntervalMs = healthPollIntervalMs
    this.recoveryDelaysMs = [...recoveryDelaysMs]
    this.confirmationTtlMs = confirmationTtlMs
    this.status = {
      state: 'checking',
      reason: null,
      canRepair: false,
      progress: null,
      origin: null,
    }
    this.origin = null
    this.context = null
    this.client = null
    this.sessionToken = null
    this.runtimeDescriptor = null
    this.installConfirmation = null
    this.removalConfirmation = null
    this.generation = 0
    this.recoveryAttempt = 0
    this.recoveryTimer = null
    this.installAbortController = null
    this.stopping = false
    this.ignoredClients = new WeakSet()
    this.startingClients = new WeakSet()
  }

  async initialize() {
    this.generation += 1
    this.installConfirmation = null
    this.removalConfirmation = null
    this.#clearRecovery()
    this.stopping = false
    this.origin = null
    this.#setStatus('checking')
    try {
      const preferences = await this.preferences.read()
      if (preferences.mode === 'external') {
        return await this.#initializeExternal(preferences.externalGatewayOrigin)
      }
      if (
        !/^[a-f\d]{64}$/.test(String(this.runtimeSha256 || ''))
        || typeof this.bundledTarballPath !== 'string'
        || !this.bundledTarballPath
      ) throw new WslRuntimeControllerError('runtime-integrity-failed')
      const discovery = await this.adapter.discover({
        configured: preferences.distribution || '',
      })
      if (!discovery?.selected || !discovery?.probe) {
        throw new WslRuntimeControllerError('no-distributions')
      }
      const architecture = String(discovery.probe.architecture || '').toLowerCase()
      if (!SUPPORTED_ARCHITECTURES.has(architecture)) {
        throw new WslRuntimeControllerError(
          'unsupported-architecture',
          { canRepair: false },
        )
      }
      const layout = createWslRuntimeLayout({
        homeDirectory: discovery.probe.home,
        desktopVersion: this.desktopVersion,
      })
      const expectedMarker = createWslRuntimeMarker({
        desktopVersion: this.desktopVersion,
        packageVersion: this.packageVersion,
        protocolVersion: this.protocolVersion,
        sha256: this.runtimeSha256,
        installedAt: new Date(this.now()).toISOString(),
      })
      const context = {
        distribution: discovery.selected,
        distributions: discovery.distributions,
        probe: discovery.probe,
        layout,
        expectedMarker,
        desktopVersion: this.desktopVersion,
        packageVersion: this.packageVersion,
        protocolVersion: this.protocolVersion,
        bundledTarballPath: this.bundledTarballPath,
      }
      const inspect = await this.adapter.inspectRuntime(context)
      context.inspect = inspect
      this.context = context
      const setup = runtimeSetupState({
        nodeVersion: discovery.probe.nodeVersion,
        npmVersion: discovery.probe.npmVersion,
        marker: inspect.marker,
        expectedMarker,
        executableExists: inspect.executableExists,
      })
      if (setup.state === 'node-required') {
        this.#setStatus('setup-required', {
          reason: 'node-required',
          canRepair: false,
          missing: setup.missing,
        })
        return this.status
      }
      if (setup.state === 'runtime-required') {
        const fallback = await this.adapter.resolveLastKnownGood(context)
        if (fallback?.marker?.protocolVersion === this.protocolVersion) {
          await this.#startRuntime(fallback, {
            syncAvailable: true,
            promote: false,
            allowFallback: false,
          })
          return this.status
        }
        this.#setStatus('setup-required', {
          reason: 'runtime-required',
          canRepair: true,
        })
        return this.status
      }
      await this.#startRuntime({
        marker: inspect.marker,
        runtimeEntry: layout.executablePath,
        layout,
      }, {
        promote: !markerMatches(inspect.currentMarker, inspect.marker),
        allowFallback: true,
      })
      return this.status
    } catch (error) {
      const failure = asControllerError(error, 'wsl-unavailable')
      this.#setStatus('error', {
        reason: failure.reason,
        canRepair: failure.canRepair,
      })
      return this.status
    }
  }

  subscribeStatus(listener) {
    if (typeof listener !== 'function') return () => {}
    this.on('status', listener)
    return () => this.off('status', listener)
  }

  async start() {
    return this.initialize()
  }

  async readSettings() {
    if (!this.client || this.status.state !== 'ready') {
      throw new WslRuntimeControllerError('runtime-required')
    }
    const result = await this.client.request('settings.read', {})
    return result.settings
  }

  async writeSettings(settings) {
    if (!this.client || !this.sessionToken) {
      throw new WslRuntimeControllerError('runtime-required')
    }
    const result = await this.client.request('settings.write', {
      sessionToken: this.sessionToken,
      settings,
    })
    if (result.origin) {
      let origin
      try {
        origin = validateExternalGatewayOrigin(result.origin)
      } catch {
        throw new WslRuntimeControllerError('gateway-start-failed')
      }
      await this.#waitForGatewayHealth(origin)
      this.origin = origin
      this.#setStatus('ready', { origin })
    }
    return {
      settings: result.settings,
      restarted: true,
      restartRequired: false,
      runtime: await this.getRuntimeStatus(),
    }
  }

  async inspectBackends({ force: _force = false } = {}) {
    if (!this.client) throw new WslRuntimeControllerError('runtime-required')
    const report = await this.client.request('backends.inspect', {})
    return {
      selected: report.selected,
      backends: (report.backends || []).map(item => ({
        id: item.id,
        label: item.label,
        ready: item.ready,
        selected: item.selected,
        issues: item.issues,
      })),
    }
  }

  async getRuntimeStatus() {
    const health = this.origin
      ? await this.adapter.readGatewayHealth(this.origin).catch(() => null)
      : null
    return mapGatewayHealthToDesktopStatus(health)
  }

  tailDiagnostics(options) {
    return this.client?.tailDiagnostics(options) || []
  }

  async getRuntimeInstallPlan() {
    const repairFlow = this.status.state === 'setup-required'
      && this.status.reason === 'runtime-required'
    const syncFlow = this.status.state === 'ready'
      && this.status.syncAvailable === true
    if ((!repairFlow && !syncFlow) || !this.context) {
      throw new WslRuntimeControllerError('confirmation-required')
    }
    const plan = await this.adapter.prepareInstallPlan(this.context)
    const confirmationId = this.randomBytes(16).toString('hex')
    this.installConfirmation = {
      id: confirmationId,
      expiresAt: this.now() + this.confirmationTtlMs,
      generation: this.generation,
      plan,
    }
    return { confirmationId, displayCommand: plan.displayCommand }
  }

  async installRuntime(confirmationId) {
    const confirmation = this.#consumeConfirmation(
      'installConfirmation',
      confirmationId,
    )
    const abortController = new AbortController()
    const previousClient = this.client
    const previousOrigin = this.origin
    const previousWasReady = this.status.state === 'ready'
    this.installAbortController = abortController
    const onProgress = progress => {
      const safe = boundedProgress(progress)
      if (!safe) return
      this.#setStatus('setup-required', {
        reason: 'runtime-required',
        canRepair: true,
        progress: safe,
      })
    }
    try {
      const payloadValid = await this.adapter.verifyRuntimePayload({
        path: this.bundledTarballPath,
        sha256: this.runtimeSha256,
      }).catch(() => false)
      if (!payloadValid) {
        throw new WslRuntimeControllerError('runtime-integrity-failed')
      }
      this.context.expectedMarker = createWslRuntimeMarker({
        desktopVersion: this.desktopVersion,
        packageVersion: this.packageVersion,
        protocolVersion: this.protocolVersion,
        sha256: this.runtimeSha256,
        installedAt: new Date(this.now()).toISOString(),
      })
      await this.adapter.installRuntime(confirmation.plan, {
        marker: this.context.expectedMarker,
        distribution: this.context.distribution,
        layout: this.context.layout,
        signal: abortController.signal,
        onProgress,
      })
      const inspect = await this.adapter.inspectRuntime(this.context)
      this.context.inspect = inspect
      const setup = runtimeSetupState({
        nodeVersion: this.context.probe.nodeVersion,
        npmVersion: this.context.probe.npmVersion,
        marker: inspect.marker,
        expectedMarker: this.context.expectedMarker,
        executableExists: inspect.executableExists,
      })
      if (setup.state !== 'ready') {
        throw new WslRuntimeControllerError('runtime-verification-failed')
      }
      await this.#stopClient()
      this.stopping = false
      await this.#startRuntime({
        marker: inspect.marker,
        runtimeEntry: this.context.layout.executablePath,
        layout: this.context.layout,
      }, { promote: true, allowFallback: true })
      return this.status
    } catch (error) {
      const failure = error?.name === 'AbortError'
        ? new WslRuntimeControllerError('cancelled', { canRepair: false })
        : asControllerError(error, 'runtime-install-failed')
      if (failure.reason === 'cancelled') {
        this.#setStatus('setup-required', {
          reason: 'cancelled',
          canRepair: false,
        })
      } else if (this.status.state !== 'ready') {
        if (
          previousWasReady
          && previousClient
          && this.client === previousClient
          && !previousClient.closed
        ) {
          this.origin = previousOrigin
          this.#setStatus('ready', {
            origin: previousOrigin,
            reason: failure.reason,
            canRepair: failure.canRepair,
            syncAvailable: true,
          })
        } else {
          this.#setStatus('error', {
            reason: failure.reason,
            canRepair: failure.canRepair,
          })
        }
      }
      throw failure
    } finally {
      if (this.installAbortController === abortController) {
        this.installAbortController = null
      }
    }
  }

  async cancelRuntimeSetup() {
    this.installAbortController?.abort()
  }

  async retry() {
    await this.stop()
    return this.initialize()
  }

  async restartRuntime() {
    if (!this.runtimeDescriptor || !this.context) return this.initialize()
    await this.#stopClient()
    this.stopping = false
    return this.#startRuntime(this.runtimeDescriptor, {
      promote: false,
      allowFallback: true,
    })
  }

  async stop() {
    this.generation += 1
    this.installConfirmation = null
    this.removalConfirmation = null
    this.installAbortController?.abort()
    this.#clearRecovery()
    this.stopping = true
    this.#setStatus('stopping')
    await this.#stopClient()
    this.origin = null
    this.sessionToken = null
  }

  async getPrivateRuntimeRemovalPlan() {
    const context = this.#managedRemovalContext()
    const validated = await this.adapter.validateRemovalTarget(context)
    if (validated.root !== context.layout.privateRoot) {
      throw new WslRuntimeControllerError('removal-target-changed')
    }
    const confirmationId = this.randomBytes(16).toString('hex')
    this.removalConfirmation = {
      id: confirmationId,
      generation: this.generation,
      expiresAt: this.now() + this.confirmationTtlMs,
      validated,
    }
    return { confirmationId, root: validated.root }
  }

  async removePrivateRuntime(confirmationId) {
    const confirmation = this.#consumeConfirmation(
      'removalConfirmation',
      confirmationId,
    )
    const externalOrigin = this.context?.mode === 'external'
      ? this.context.origin
      : null
    const context = this.#managedRemovalContext()
    try {
      await this.stop()
      const revalidated = await this.adapter.validateRemovalTarget(context)
      if (
        revalidated.root !== confirmation.validated.root
        || !markerMatches(revalidated.marker, confirmation.validated.marker)
      ) throw new WslRuntimeControllerError('removal-target-changed')
      await this.adapter.removePrivateRuntime({
        distribution: context.distribution,
        root: revalidated.root,
        marker: revalidated.marker,
      })
      if (externalOrigin) {
        this.context = null
        this.stopping = false
        await this.#initializeExternal(externalOrigin)
      } else {
        this.context = context
        this.#setStatus('setup-required', {
          reason: 'runtime-required',
          canRepair: true,
        })
      }
    } catch (error) {
      const failure = asControllerError(error, 'runtime-removal-failed')
      this.#setStatus('error', {
        reason: failure.reason,
        canRepair: failure.canRepair,
      })
      throw failure
    }
  }

  #consumeConfirmation(field, id) {
    const value = this[field]
    this[field] = null
    if (!value || value.id !== id || value.generation !== this.generation) {
      throw new WslRuntimeControllerError('confirmation-required')
    }
    if (this.now() > value.expiresAt) {
      throw new WslRuntimeControllerError('confirmation-expired')
    }
    return value
  }

  #managedRemovalContext() {
    const context = this.context?.mode === 'external'
      ? this.context.managed
      : this.context
    if (!context?.layout?.privateRoot) {
      throw new WslRuntimeControllerError('confirmation-required')
    }
    return context
  }

  async #initializeExternal(value) {
    const origin = validateExternalGatewayOrigin(value)
    const managed = this.context?.mode === 'external'
      ? this.context.managed
      : this.context?.layout ? this.context : null
    this.context = { mode: 'external', origin, managed }
    const health = await this.adapter.readGatewayHealth(origin).catch(() => null)
    this.origin = health ? origin : null
    this.#setStatus('external', {
      origin: this.origin,
      reason: health ? null : 'external-unavailable',
      canRepair: !health,
    })
    if (!health) this.#scheduleExternalReconnect(origin, 0)
    return this.status
  }

  #scheduleExternalReconnect(origin, attempt) {
    if (this.stopping || this.context?.mode !== 'external') return
    const index = Math.min(attempt, this.recoveryDelaysMs.length - 1)
    const waitMs = this.recoveryDelaysMs[index]
    this.recoveryTimer = setTimeout(async () => {
      this.recoveryTimer = null
      if (this.stopping || this.context?.mode !== 'external') return
      const health = await this.adapter.readGatewayHealth(origin).catch(() => null)
      if (health) {
        this.origin = origin
        this.#setStatus('external', { origin })
      } else {
        this.#setStatus('external', {
          reason: 'external-unavailable',
          canRepair: true,
        })
        this.#scheduleExternalReconnect(origin, attempt + 1)
      }
    }, waitMs)
  }

  async #startRuntime(descriptor, {
    promote,
    syncAvailable = false,
    allowFallback,
  }) {
    this.#setStatus('starting', { syncAvailable })
    const sessionToken = this.randomBytes(32).toString('hex')
    let client
    let stage = 'bridge-handshake-failed'
    try {
      const child = await this.adapter.spawnHost({
        ...this.context,
        ...descriptor,
        sessionToken,
      })
      client = this.createClient({ child, sessionToken })
      this.client = client
      this.startingClients.add(client)
      this.#bindClient(client)
      const hello = await client.waitForHello()
      this.#assertHello(hello, descriptor.marker)
      stage = 'gateway-start-failed'
      const started = await client.request('gateway.start', { sessionToken })
      let origin
      try {
        origin = validateExternalGatewayOrigin(started?.origin)
      } catch {
        throw new WslRuntimeControllerError('gateway-start-failed')
      }
      stage = 'gateway-health-timeout'
      await this.#waitForGatewayHealth(origin)
      if (promote) {
        stage = 'runtime-promotion-failed'
        const currentMarker = createCurrentRuntimeMarker({
          marker: descriptor.marker,
          bridgeReady: true,
          gatewayHealthy: true,
          promotedAt: new Date(this.now()).toISOString(),
        })
        await this.adapter.promoteCurrent({
          ...this.context,
          layout: descriptor.layout || this.context.layout,
          marker: descriptor.marker,
          currentMarker,
        })
      }
      this.runtimeDescriptor = descriptor
      this.sessionToken = sessionToken
      this.origin = origin
      this.recoveryAttempt = 0
      this.startingClients.delete(client)
      this.#setStatus('ready', { origin, syncAvailable })
      return this.status
    } catch (error) {
      if (client) {
        this.startingClients.delete(client)
        this.ignoredClients.add(client)
        if (!client.closed) await client.shutdown().catch(() => {})
        if (this.client === client) this.client = null
        if (this.client === null) this.sessionToken = null
      }
      if (allowFallback) {
        const fallback = await this.adapter.resolveLastKnownGood(this.context)
        if (
          fallback?.marker?.protocolVersion === this.protocolVersion
          && fallback.marker.desktopVersion !== descriptor.marker.desktopVersion
        ) {
          return this.#startRuntime(fallback, {
            promote: false,
            syncAvailable: true,
            allowFallback: false,
          })
        }
      }
      throw asControllerError(error, stage)
    }
  }

  #assertHello(hello, runtimeMarker) {
    if (
      hello?.protocol !== this.protocolVersion
      || hello.packageVersion !== runtimeMarker.packageVersion
      || hello.distribution !== this.context.distribution
      || normalizeNodeVersion(hello.nodeVersion)
        !== normalizeNodeVersion(this.context.probe.nodeVersion)
    ) throw new WslRuntimeControllerError('bridge-handshake-failed')
  }

  async #waitForGatewayHealth(origin) {
    const attempts = Math.max(
      1,
      Math.ceil(this.healthTimeoutMs / this.healthPollIntervalMs),
    )
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const health = await this.adapter.readGatewayHealth(origin)
      if (health && typeof health === 'object' && health.backend) return
      if (attempt + 1 < attempts) await delay(this.healthPollIntervalMs)
    }
    throw new WslRuntimeControllerError('gateway-health-timeout')
  }

  #bindClient(client) {
    client.on('status', status => {
      if (client !== this.client || this.stopping) return
      if (status?.state === 'recovering') {
        this.#setStatus('recovering', {
          reason: status.reason || 'gateway-recovering',
          retry: status.retry,
          delayMs: status.delayMs,
          origin: this.origin,
        })
      } else if (status?.state === 'ready') {
        this.#setStatus('ready', { origin: status.origin || this.origin })
      } else if (status?.state === 'error') {
        this.#setStatus('error', {
          reason: 'gateway-start-failed',
          canRepair: true,
        })
      }
    })
    client.on('closed', () => {
      if (
        client !== this.client
        || this.stopping
        || this.ignoredClients.has(client)
        || this.startingClients.has(client)
      ) return
      this.client = null
      this.sessionToken = null
      this.origin = null
      this.#scheduleBridgeRecovery()
    })
  }

  #scheduleBridgeRecovery() {
    if (this.stopping || this.recoveryTimer) return
    if (this.recoveryAttempt >= this.recoveryDelaysMs.length) {
      this.#setStatus('error', {
        reason: 'bridge-recovery-exhausted',
        canRepair: true,
      })
      return
    }
    const delayMs = this.recoveryDelaysMs[this.recoveryAttempt]
    const retry = this.recoveryAttempt + 1
    this.recoveryAttempt = retry
    this.#setStatus('recovering', {
      reason: 'bridge-exited',
      retry,
      delayMs,
    })
    this.recoveryTimer = setTimeout(async () => {
      this.recoveryTimer = null
      try {
        await this.#startRuntime(this.runtimeDescriptor, {
          promote: false,
          allowFallback: true,
        })
      } catch {
        this.#scheduleBridgeRecovery()
      }
    }, delayMs)
  }

  async #stopClient() {
    const client = this.client
    this.client = null
    this.sessionToken = null
    if (!client) return
    this.ignoredClients.add(client)
    await client.shutdown().catch(() => {})
  }

  #clearRecovery() {
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer)
    this.recoveryTimer = null
    this.recoveryAttempt = 0
  }

  #setStatus(state, details = {}) {
    this.status = {
      state,
      reason: details.reason ?? null,
      canRepair: details.canRepair ?? false,
      progress: details.progress ?? null,
      origin: details.origin ?? this.origin,
      ...(details.missing ? { missing: [...details.missing] } : {}),
      ...(details.retry !== undefined ? { retry: details.retry } : {}),
      ...(details.delayMs !== undefined ? { delayMs: details.delayMs } : {}),
      ...(details.syncAvailable ? { syncAvailable: true } : {}),
    }
    this.emit('status', { ...this.status })
  }
}
