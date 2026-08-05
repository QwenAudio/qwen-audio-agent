import { dirname, resolve } from 'node:path'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { loadRuntimeEnvironment } from '../../shared/runtime-environment.mjs'
import { createLogger } from '../../shared/logger.mjs'
import { acquireGatewayLease } from '../../shared/gateway-instance-lock.mjs'
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
