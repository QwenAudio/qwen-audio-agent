import { createInterface } from 'node:readline'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { EvaScenarios } from './eva-scenarios.mjs'

const protocolWrite = value => process.stdout.write(`${JSON.stringify(value)}\n`)
console.log = (...args) => console.error(...args)

const [origin, token, runtimeRoot] = process.argv.slice(2)
if (!origin || !token || !runtimeRoot) throw new Error('Usage: eva-harness-bridge.mjs ORIGIN TOKEN RUNTIME_ROOT')
mkdirSync(runtimeRoot, { recursive: true })
process.env.QWAUDIO_CONFIG_DIR = runtimeRoot
process.env.QWAUDIO_DATA_DIR = runtimeRoot
process.env.NODE_ENV = 'test'
process.env.CS_DOMAIN = 'airline'

const configResponse = await fetch(new URL('/harness/config', origin), {
  headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
})
const bridgeConfig = await configResponse.json()
if (!configResponse.ok) throw new Error(bridgeConfig.error || 'Unable to load EVA harness configuration')

const [
  { loadServiceEnvironment }, { CustomerService }, { startCustomerServiceServer },
  { startServiceAgentServer }, { DashScopeServiceModel },
  { createFullHarness, withTauPolicy }, { config }, { resolveRealtimeProvider },
] = await Promise.all([
  import('../bootstrap/environment.mjs'), import('../service/service.mjs'),
  import('../service/server.mjs'), import('../agent/server.mjs'), import('../agent/model.mjs'),
  import('./realtime-harness.mjs'), import('../../../server/src/core/config.mjs'),
  import('../../../server/src/voice/providers/registry.mjs'),
])
loadServiceEnvironment()

const scenarios = new EvaScenarios({
  origin, token, sessionId: bridgeConfig.sessionId, policy: bridgeConfig.policy,
  definitions: bridgeConfig.definitions, currentDateTime: bridgeConfig.currentDateTime,
})
const service = new CustomerService({ scenarios })
const serviceServer = await startCustomerServiceServer({ port: 0, service })
const backendModel = new DashScopeServiceModel({ model: bridgeConfig.backendModel })
const agentServer = await startServiceAgentServer({
  port: 0, serviceOrigin: serviceServer.origin, sessionId: bridgeConfig.sessionId,
  model: backendModel,
})
const originalProvider = resolveRealtimeProvider('dashscope')
const provider = withTauPolicy(originalProvider, {
  mode: 'harness', policy: bridgeConfig.policy, definitions: bridgeConfig.definitions,
  currentDateTime: bridgeConfig.currentDateTime,
})
const controller = new AbortController()
const events = []
const client = await createFullHarness({
  provider, agentServer, serviceOrigin: serviceServer.origin,
  sessionId: bridgeConfig.sessionId, definitions: bridgeConfig.definitions,
  directory: resolve(runtimeRoot, `gateway-${randomUUID()}`), config,
  signal: controller.signal, events, turnTimeoutMs: bridgeConfig.turnTimeoutMs,
})

let queue = Promise.resolve()
let closed = false
async function close() {
  if (closed) return
  closed = true
  controller.abort(new Error('EVA harness bridge closed'))
  await Promise.allSettled([client.close(), agentServer.close(), serviceServer.close()])
  scenarios.close()
}

protocolWrite({ type: 'ready' })
const lines = createInterface({ input: process.stdin })
lines.on('line', line => {
  queue = queue.then(async () => {
    let request
    try {
      request = JSON.parse(line)
      if (request.method === 'turn') {
        const text = await client.turn(String(request.text || ''))
        protocolWrite({ id: request.id, result: { text, counts: client.counts() } })
      } else if (request.method === 'close') {
        await close()
        // Keep the protocol response small. Emitting the full event trace here can
        // exceed the stdout pipe buffer and be truncated by process shutdown.
        protocolWrite({ id: request.id, result: { ok: true, eventCount: events.length } })
        lines.close()
      } else throw new Error(`Unknown bridge method: ${request.method}`)
    } catch (error) {
      protocolWrite({ id: request?.id, error: error?.message || String(error) })
    }
  })
})
lines.on('close', () => { close().finally(() => { process.exitCode = 0 }) })
process.once('SIGTERM', () => { close().finally(() => process.exit(0)) })
