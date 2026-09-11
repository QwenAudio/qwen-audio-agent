// Setup gate: whether the Gateway may start, and what is still missing.
//
// A Gateway that listens but cannot connect its voice is harder to diagnose
// than a refusal it can act on — the user only discovers the missing
// credential when their first sentence fails. Callers therefore check this
// before starting and refuse with the `missing` list instead of serving a
// half-dead instance.
//
// Each `missing` entry carries the settings `field`, its environment `key`
// and a message fit for a UI, so both the CLI and an integrating platform can
// present the same answer.
import { resolveRealtimeFrontendConfiguration } from '../realtime-provider-catalog.mjs'

export function gatewaySetupStatus(env = process.env) {
  const frontend = resolveRealtimeFrontendConfiguration(env)
  const missing = []
  if (!frontend.configured) {
    missing.push(frontend.provider === 'dashscope'
      ? {
          field: 'dashscopeApiKey',
          key: 'DASHSCOPE_API_KEY',
          message: frontend.missingConfigurationMessage,
        }
      : {
          field: 'speechToSpeechRealtimeUrl',
          key: 'SPEECH_TO_SPEECH_REALTIME_URL',
          message: frontend.missingConfigurationMessage,
        })
  }
  return {
    ready: missing.length === 0,
    provider: frontend.provider,
    missing,
  }
}

// Refuses an unconfigured start with an actionable error instead of a
// half-dead instance. `QWEN_AUDIO_ALLOW_UNCONFIGURED=1` opts out for
// debugging and harness setups that never open a voice connection.
export function assertGatewaySetup(env = process.env) {
  if (String(env.QWEN_AUDIO_ALLOW_UNCONFIGURED || '') === '1') return
  const status = gatewaySetupStatus(env)
  if (status.ready) return
  const error = new Error(
    `Gateway 启动被拒绝，缺少必填配置：${
      status.missing.map(item => `${item.key}（${item.message}）`).join('；')
    }`,
  )
  error.code = 'QWAUDIO_GATEWAY_SETUP_REQUIRED'
  error.missing = status.missing
  throw error
}
