// Foreground composition root for the cockpit showcase. Keep scenario choices
// here and consume only public qwen-audio-agent exports; do not copy framework
// runtime logic or move cockpit business state into the Gateway.
import { fileURLToPath, pathToFileURL } from 'node:url'
import { cockpitAssistantProfileEventDefinition } from './assistant/event.mjs'
import { loadCockpitEnvironment } from '../bootstrap/environment.mjs'
import { COCKPIT_SPAWN_THINKING_DESCRIPTION } from './spawn-thinking-tool.mjs'

loadCockpitEnvironment()
process.env.QWAUDIO_CONFIG_DIR ||= fileURLToPath(new URL('../.runtime', import.meta.url))
process.env.QWAUDIO_DATA_DIR ||= process.env.QWAUDIO_CONFIG_DIR
if (!process.env.COCKPIT_FRONTEND_MCP_URL) {
  const frontendMcpUrl = new URL(
    '/mcp/frontend',
    process.env.COCKPIT_SERVICE_ORIGIN || 'http://127.0.0.1:3010',
  )
  frontendMcpUrl.searchParams.set('cockpitId', process.env.COCKPIT_ID || 'default')
  process.env.COCKPIT_FRONTEND_MCP_URL = frontendMcpUrl.toString()
}
process.env.QWEN_AUDIO_FRONTEND_PROFILE ||= fileURLToPath(
  new URL('./frontend-profile.json', import.meta.url),
)

const [
  { createGatewayApplication },
  { createBackendAgentHost },
  { createA2ABackendAdapter },
] = await Promise.all([
  import('qwen-audio-agent/gateway-application'),
  import('qwen-audio-agent/backend-adapter-sdk'),
  import('qwen-audio-agent/a2a-backend-adapter'),
])

function port(value, fallback) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65_535
    ? parsed
    : fallback
}

export async function waitForCockpitService({
  origin = process.env.COCKPIT_SERVICE_ORIGIN || 'http://127.0.0.1:3010',
  timeoutMs = 8_000,
  intervalMs = 100,
  fetchImpl = fetch,
} = {}) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(new URL('/health', origin))
      if (response.ok) return
      lastError = new Error(`Cockpit Service health returned ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  throw new Error(`Cockpit Service is not ready: ${lastError?.message || origin}`)
}

export function startCockpitGateway({
  host = process.env.COCKPIT_GATEWAY_HOST || '127.0.0.1',
  port: listenPort = port(process.env.COCKPIT_GATEWAY_PORT, 18_888),
  agentCardUrl = process.env.COCKPIT_AGENT_CARD_URL
    || 'http://127.0.0.1:3020/.well-known/agent-card.json',
} = {}) {
  const backend = createA2ABackendAdapter({
    agentCardUrl,
    label: 'Cockpit Agent',
  })
  const agent = createBackendAgentHost(backend, {
    name: 'Cockpit A2A Agent',
  })
  const application = createGatewayApplication({
    agent,
    autoStart: false,
    clientEventDefinitions: [cockpitAssistantProfileEventDefinition],
    spawnThinkingDescription: COCKPIT_SPAWN_THINKING_DESCRIPTION,
  })
  const server = application.start({ host, port: listenPort })
  let closePromise = null

  return {
    application,
    agent,
    server,
    close() {
      if (closePromise) return closePromise
      closePromise = (async () => {
        try {
          await application.close()
        } finally {
          await agent.close()
        }
      })()
      return closePromise
    },
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await waitForCockpitService()
  const runtime = startCockpitGateway()
  runtime.server.once('listening', () => {
    const address = runtime.server.address()
    console.log(`Cockpit Gateway listening on http://${address.address}:${address.port}`)
  })
  const close = async () => {
    await runtime.close()
    process.exit(0)
  }
  process.once('SIGINT', close)
  process.once('SIGTERM', close)
}
