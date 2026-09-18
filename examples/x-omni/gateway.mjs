import { fileURLToPath, pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import { once } from 'node:events'
import { z } from 'zod'
import { CAPTURE_ACTION } from './vision/frame.mjs'
import { DashScopeVisualReader } from './vision/dashscope-reader.mjs'
import { createVisionTools } from './vision/tools.mjs'
import { visualFeatures } from './vision/features.mjs'

const directory = fileURLToPath(new URL('.', import.meta.url))

export async function startXOmni({ port = 18_890, host = '127.0.0.1', envFile = `${directory}.env.local` } = {}) {
  if (envFile && existsSync(envFile)) process.loadEnvFile(envFile)
  // Isolated state: never read/write a running desktop's conversation or config.
  process.env.QWAUDIO_CONFIG_DIR ||= `${directory}.runtime`
  process.env.QWEN_AUDIO_AGENT_RUNTIME_ROOT ||= directory
  process.env.QWEN_AUDIO_AGENT_FRONTEND_PROMPT_DIR ||= fileURLToPath(new URL('../../config/frontend-agent', import.meta.url))
  process.env.QWEN_AUDIO_AGENT_ASSISTANT_PROFILE_PATH ||= fileURLToPath(new URL('../../config/frontend-agent/ASSISTANT.md', import.meta.url))
  process.env.AGENT_PROTOCOL ||= 'none'
  process.env.QWEN_AUDIO_REALTIME_PROVIDER ||= 'dashscope'
  process.env.QWEN_AUDIO_REALTIME_MODEL ||= 'qwen3.5-omni-plus-realtime'
  // Use the same configured adapter/profile as the Gateway; never assume that
  // every multimodal service implements tool calls or manual text responses.
  const { resolveRealtimeProvider } = await import('../../server/src/voice/providers/registry.mjs')
  const provider = resolveRealtimeProvider()
  const features = visualFeatures({ provider: provider.key, modelProfile: provider.modelProfile?.() })
  if (!features.continuous && !features.visualTools) {
    throw new Error('X-Omni requires a visual Realtime provider. For MiniCPM-o, configure the mode=video endpoint.')
  }
  if (!provider.isConfigured()) throw new Error(provider.missingConfigurationMessage)
  const reader = features.visualTools ? new DashScopeVisualReader({
    apiKey: process.env.DASHSCOPE_API_KEY,
    model: process.env.QWEN_AUDIO_REALTIME_MODEL,
    endpoint: process.env.QWEN_AUDIO_REALTIME_BASE_URL || undefined,
  }) : null
  const tools = reader ? createVisionTools({ reader }) : null
  const { createGatewayApplication } = await import('qwen-audio-agent/gateway-application')
  const { createAgentDelivery } = await import('qwen-audio-agent/agent-delivery')
  const application = createGatewayApplication({
    autoStart: false,
    clientActionNames: tools ? [CAPTURE_ACTION] : [],
    frontendToolSources: tools ? [tools] : [],
    clientEventDefinitions: tools ? [{
      name: 'xomni.visual.state',
      schema: z.object({ source: z.enum(['camera', 'screen', 'image', 'none']),
        mode: z.enum(['on-demand', 'continuous']), active: z.boolean(), generation: z.string().max(80) }).strict(),
      retention: 'latest', route: 'context', maxBytes: 1024,
      rateLimit: { max: 10, windowMs: 10_000 },
      handle(event) {
        // A source/mode change invalidates outstanding observations immediately.
        tools.invalidateSession(event.source)
      },
      project: event => createAgentDelivery({
        id: event.id, mode: 'context', origin: 'x-omni-visual-state',
        text: `Client visual state: source=${event.data.source}, mode=${event.data.mode}, available=${event.data.active}. In on-demand mode, call capture_visual to read a fresh frame. Earlier observations are historical, not a live view. This is context, not a user request.`,
        presentation: { contextTiming: 'immediate' },
      }),
    }] : [],
  })
  try {
    application.start({ host, port })
    if (!application.server.listening) await once(application.server, 'listening')
  } catch (error) { await application.close(); throw error }
  return application
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const application = await startXOmni({ port: Number(process.env.X_OMNI_GATEWAY_PORT) || 18_890 })
  const shutdown = async () => { await application.close(); process.exit(0) }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}
