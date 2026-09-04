import { createGatewayApplication } from 'qwen-audio-agent/gateway-application'
import {
  applyRecommendedDashScopeConfiguration,
  VoiceMemMemoryProvider,
} from './voicemem-memory-provider.mjs'

// VoiceMem uses OpenAI-compatible environment names. Keep that vendor detail
// inside this composition example and reuse Model Studio credentials when the
// caller did not explicitly configure another compatible endpoint.
applyRecommendedDashScopeConfiguration()

const memoryProvider = new VoiceMemMemoryProvider()
const gateway = createGatewayApplication({ memoryProvider })

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await gateway.close()
    process.exit(0)
  })
}
