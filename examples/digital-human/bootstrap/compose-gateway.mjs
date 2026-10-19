// Composes the Gateway for the digital-human demo: injects the DHAV provider,
// the persona allowlist and the media adapter, and enables WebRTC with avatar
// video downlink. The avatar UI is this example's own SPA (client/), published
// through the Gateway's pre-existing /skins static mount, so the demo opens
// `/skins/digital-human/index.html?persona=<id>` and the product web/ app is
// never involved. Follows the x-omni composition pattern (autoStart:false,
// isolated config dir, explicit start).

import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { EXAMPLE_ROOT } from './env.mjs'
import { createDhavProvider } from '../providers/dhav-provider.mjs'
import { assertDigitalHumanOptions, createDigitalHumanRuntime } from '../presentation/index.mjs'
import { MOCK_PERSONAS } from '../providers/mock/mock-renderer-server.mjs'

// Real GPU renderer personas (FlashHead). Kept separate from the Mock set so the
// demo can drive either; the startup persona picks the allowlist entry the
// client's ?avatar= may select. avatarAssetId must be a non-empty string
// (assertDigitalHumanOptions); the actual look is decided server-side.
const FLASHHEAD_PERSONAS = { 'flashhead-default': { avatarAssetId: 'flashhead-girl' } }
const ALL_PERSONAS = { ...MOCK_PERSONAS, ...FLASHHEAD_PERSONAS }

export function digitalHumanOptions({ rendererUrl, persona, mediaAdapterPath, firstMediaTimeoutMs = 4000, authToken = null }) {
  const personas = persona && ALL_PERSONAS[persona]
    ? { [persona]: { avatarAssetId: ALL_PERSONAS[persona].avatarAssetId } }
    : Object.fromEntries(Object.entries(ALL_PERSONAS).map(([id, value]) => [id, { avatarAssetId: value.avatarAssetId }]))
  const options = assertDigitalHumanOptions({
    provider: createDhavProvider({ rendererBaseUrl: rendererUrl, authToken, firstMediaTimeoutMs }),
    personas,
    rendererAllowlist: [rendererUrl],
    mediaAdapter: { modulePath: mediaAdapterPath },
    firstMediaTimeoutMs,
  })
  // The Gateway only knows the injected contract: `personas` feeds its allowlist
  // and `createRuntime()` is called once per avatar connection. Returning null
  // keeps that connection on the plain audio path.
  return { ...options, createRuntime: args => createDigitalHumanRuntime({ options, ...args }) }
}

export async function startDigitalHumanGateway({
  host = '127.0.0.1', port = 18895, rendererUrl, persona = 'mock-default',
  mediaAdapterPath, authToken = null, envFile = `${EXAMPLE_ROOT}.env.local`, model,
} = {}) {
  if (envFile && existsSync(envFile)) process.loadEnvFile(envFile)
  // Isolated state: never read/write a running desktop's conversation or config.
  process.env.QWAUDIO_CONFIG_DIR ||= `${EXAMPLE_ROOT}.runtime`
  process.env.QWEN_AUDIO_AGENT_RUNTIME_ROOT ||= EXAMPLE_ROOT
  process.env.QWEN_AUDIO_AGENT_FRONTEND_PROMPT_DIR ||= fileURLToPath(new URL('../../../config/frontend-agent', import.meta.url))
  process.env.QWEN_AUDIO_AGENT_ASSISTANT_PROFILE_PATH ||= fileURLToPath(new URL('../../../config/frontend-agent/ASSISTANT.md', import.meta.url))
  process.env.AGENT_PROTOCOL ||= 'none'
  process.env.QWEN_AUDIO_REALTIME_PROVIDER ||= 'dashscope'
  // M1b pairs the avatar with the Audio model: no camera input, so only the
  // recvonly avatar video track is negotiated (the dual-video path is unverified).
  process.env.QWEN_AUDIO_REALTIME_MODEL ||= model || 'qwen-audio-3.0-realtime-plus'
  process.env.QWAUDIO_WEBRTC_ENABLED = '1'
  // Serve this example's built SPA from the Gateway's own /skins mount, which is
  // registered before the product SPA's static handler. ||= so an embedding host
  // can point the demo at a different skins tree.
  process.env.QWEN_AUDIO_WEB_SKINS_DIR ||= `${EXAMPLE_ROOT}skins`

  const { requireWebRtcDependencies } = await import('../../../shared/gateway/webrtc.mjs')
  requireWebRtcDependencies()

  // This example has its own package.json (for the private `ws` dependency), so
  // the root package's `qwen-audio-agent/*` self-reference does not resolve here.
  // Import the framework entry points by relative path instead; the example is
  // deliberately not part of the root workspaces.
  const { createGatewayApplication } = await import('../../../server/src/app/gateway-application.mjs')
  const application = createGatewayApplication({
    autoStart: false,
    digitalHuman: digitalHumanOptions({ rendererUrl, persona, mediaAdapterPath, authToken }),
  })
  try {
    application.start({ host, port })
    if (!application.server.listening) await once(application.server, 'listening')
  } catch (error) {
    await application.close()
    throw error
  }
  return application
}
