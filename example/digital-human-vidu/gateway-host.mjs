import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { desktopGatewayEnvironment } from '../../desktop/src/gateway-process.mjs'
import { readGatewayHealth } from '../../shared/gateway/http-client.mjs'
import { findRunningGateway } from '../../shared/gateway/lease.mjs'
import { GatewayProcess } from '../../shared/gateway/process.mjs'
import { loadRuntimeEnvironment } from '../../shared/runtime-environment.mjs'
import { runtimePathEnvironment } from '../../shared/runtime-paths.mjs'

export function localGatewayOrigin(value) {
  const url = new URL(value)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('VIDU_GATEWAY_ORIGIN must be a local HTTP origin')
  }
  return url.origin
}

// Use the same configuration and Gateway lease as the stock orb. Only stop a
// Gateway this host started; never terminate a borrowed desktop/CLI instance.
export async function startSharedGateway({
  env = process.env,
  sourceRoot = fileURLToPath(new URL('../../', import.meta.url)),
  loadRuntime = loadRuntimeEnvironment,
  findGateway = findRunningGateway,
  readHealth = readGatewayHealth,
  createProcess = options => new GatewayProcess(options),
} = {}) {
  if (env.VIDU_GATEWAY_ORIGIN) {
    const origin = localGatewayOrigin(env.VIDU_GATEWAY_ORIGIN)
    if (!await readHealth(origin)) throw new Error('Configured Gateway is unavailable')
    return { origin, borrowed: true, close: async () => {} }
  }
  const runtime = loadRuntime({ root: sourceRoot, env, defaultStateDirectory: 'state/desktop',
    prepareBackendRuntime: false, generateSecret: false, readOnly: true })
  const configured = runtimePathEnvironment(runtime)
  const active = await findGateway(runtime.stateDirectory, { readHealth })
  if (active) return { origin: localGatewayOrigin(active.origin), borrowed: true, close: async () => {} }
  const gateway = createProcess({
    preferredPort: 3101,
    env: desktopGatewayEnvironment({ env, configured, runtimeRoot: sourceRoot, sourceRoot }),
    forkImpl: (entry, args, options) => fork(entry, args, { ...options, stdio: ['inherit', 'inherit', 'inherit', 'ipc'] }),
    owner: 'digital-human-vidu',
  })
  try {
    const origin = localGatewayOrigin(await gateway.start())
    return { origin, borrowed: false, close: () => gateway.stop() }
  } catch (error) {
    await gateway.stop()
    const winner = await findGateway(runtime.stateDirectory, { readHealth, timeoutMs: 3000 })
    if (!winner) throw error
    return { origin: localGatewayOrigin(winner.origin), borrowed: true, close: async () => {} }
  }
}
