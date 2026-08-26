import { dirname, resolve } from 'node:path'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { loadRuntimeEnvironment } from '../../shared/runtime-environment.mjs'
import { ensureBackendSkills } from '../../shared/skill-library.mjs'
import { createLogger } from '../../shared/logger.mjs'
import { acquireGatewayLease } from '../../shared/gateway-instance-lock.mjs'
import { assertGatewaySetup } from '../../shared/gateway-setup.mjs'
import { startManagedBackend } from './process/managed-backend.mjs'

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const root = process.env.QWEN_AUDIO_AGENT_RUNTIME_ROOT || sourceRoot
const runtimeEnvironment = loadRuntimeEnvironment({ root })

const logger = createLogger({
  component: 'gateway',
  fileName: 'gateway.log',
})

let backendRuntime
let agentClient
let stopPromise
let exitTimer
let gatewayLease
let gatewayHeartbeat

function stop(signal = 'SIGTERM') {
  if (stopPromise) return stopPromise
  clearInterval(gatewayHeartbeat)
  stopPromise = Promise.all([
    backendRuntime?.stop(signal),
    agentClient?.close(),
  ]).catch(error => {
    logger.error('backend.stop_failed', { error })
  }).finally(() => logger.flush())
  return stopPromise
}

function stopAndExit(signal) {
  if (!exitTimer) {
    exitTimer = setTimeout(() => process.exit(0), 2000)
  }
  stop(signal).finally(() => process.exit(0))
}

try {
  // Setup gate: refuse an unconfigured start before touching the lease. A
  // Gateway that listens but cannot connect its voice is harder to diagnose
  // than a refusal the user can act on.
  assertGatewaySetup()
  gatewayLease = acquireGatewayLease(runtimeEnvironment.configDirectory, {
    owner: process.env.QWEN_AUDIO_GATEWAY_OWNER
      || (process.env.QWEN_AUDIO_AGENT_DESKTOP === '1' ? 'desktop' : 'cli'),
  })
  process.env.QWEN_AUDIO_GATEWAY_INSTANCE_ID = gatewayLease.instanceId
  process.env.QWEN_AUDIO_GATEWAY_STARTED_AT = new Date().toISOString()
  logger.info('gateway.lease_acquired', {
    instanceId: gatewayLease.instanceId,
    owner: process.env.QWEN_AUDIO_GATEWAY_OWNER
      || (process.env.QWEN_AUDIO_AGENT_DESKTOP === '1' ? 'desktop' : 'cli'),
  })
  // 切换/新装后台后把已装技能补齐。日常是毫秒级本地 diff；仅确实
  // 缺失时同步跑一次 skills.sh，保证后台首次扫描前技能已就位。
  try {
    const backfill = ensureBackendSkills({ protocol: process.env.AGENT_PROTOCOL })
    if (backfill.refreshed) {
      logger.info('skills.backfilled', {
        backend: process.env.AGENT_PROTOCOL,
        installer: backfill.installer,
        installed: backfill.installed,
      })
    }
    for (const failure of backfill.failures || []) {
      logger.warn('skills.backfill_failed', failure)
    }
  } catch (error) {
    // 离线等失败不阻塞语音网关启动；技能可下次启动再补。
    logger.warn('skills.backfill_failed', { error })
  }
  backendRuntime = await startManagedBackend({ root, logger })
  const managedBackend = backendRuntime.child
  const onManagedBackendExit = (code, signal) => {
    if (stopPromise) return
    const reason = signal || code || 'unknown'
    logger.error('backend.exited', { code, signal, reason })
    stopPromise = Promise.resolve(agentClient?.close()).catch(error => {
      logger.error('backend.stop_failed', { error })
    })
    stopPromise.finally(() => process.exit(1))
  }
  if (managedBackend?.exitCode != null || managedBackend?.signalCode != null) {
    onManagedBackendExit(
      managedBackend.exitCode,
      managedBackend.signalCode,
    )
  } else {
    managedBackend?.once('exit', onManagedBackendExit)
  }
  const agentModule = await import('./agent/agent-client.mjs')
  agentClient = agentModule.agent
  process.once('SIGINT', () => {
    stopAndExit('SIGINT')
  })
  process.once('SIGTERM', () => {
    stopAndExit('SIGTERM')
  })
  if (process.connected) {
    process.once('disconnect', () => {
      stopAndExit('SIGTERM')
    })
  }
  process.once('exit', () => {
    clearInterval(gatewayHeartbeat)
    backendRuntime?.close()
    agentClient?.close()
    gatewayLease?.release()
  })
  const { server } = await import('./app/bootstrap.mjs')
  if (!server.listening) await once(server, 'listening')
  const address = server.address()
  const port = address && typeof address === 'object'
    ? address.port
    : Number(process.env.PORT || 3101)
  const host = process.env.HOST || '127.0.0.1'
  gatewayLease.update({
    state: 'ready',
    origin: `http://${host}:${port}`,
  })
  gatewayHeartbeat = setInterval(() => gatewayLease?.update(), 15_000)
  gatewayHeartbeat.unref?.()
} catch (error) {
  clearInterval(gatewayHeartbeat)
  stop()
  gatewayLease?.release()
  logger.fatal('gateway.start_failed', { error })
  process.exitCode = 1
}
