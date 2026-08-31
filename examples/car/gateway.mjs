import { fileURLToPath, pathToFileURL } from 'node:url'

process.env.QWAUDIO_CONFIG_DIR ||= fileURLToPath(new URL('./.runtime', import.meta.url))
process.env.QWAUDIO_DATA_DIR ||= process.env.QWAUDIO_CONFIG_DIR
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
