// Read-only compatibility at the config boundary. New settings are always
// written with the shared REALTIME_* names; legacy names are not runtime fields.
import { resolveDashScopeRealtimeModelProfile } from './realtime-model-catalog.mjs'

const LEGACY_FIELDS = {
  dashscope: {
    API_KEY: ['DASHSCOPE_API_KEY'], URL: ['QWEN_AUDIO_REALTIME_BASE_URL', 'QWEN_AUDIO_REALTIME_ENDPOINT'],
  },
  stepfun: {
    API_KEY: ['STEPFUN_API_KEY'], URL: ['STEPFUN_REALTIME_URL'],
    MODEL: ['STEPFUN_REALTIME_MODEL'], VOICE: ['STEPFUN_REALTIME_VOICE'],
  },
  'gpt-live': {
    API_KEY: ['OPENAI_API_KEY', 'GPT_LIVE_API_KEY'], URL: ['GPT_LIVE_REALTIME_URL', 'OPENAI_REALTIME_URL'],
    MODEL: ['GPT_LIVE_REALTIME_MODEL', 'OPENAI_REALTIME_MODEL'], VOICE: ['GPT_LIVE_REALTIME_VOICE', 'OPENAI_REALTIME_VOICE'],
  },
  'google-live': {
    API_KEY: ['GOOGLE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_LIVE_API_KEY'], URL: ['GOOGLE_LIVE_REALTIME_URL', 'GEMINI_LIVE_REALTIME_URL'],
    MODEL: ['GOOGLE_LIVE_REALTIME_MODEL', 'GEMINI_LIVE_REALTIME_MODEL'], VOICE: ['GOOGLE_LIVE_REALTIME_VOICE', 'GEMINI_LIVE_REALTIME_VOICE'],
  },
  'doubao-seeduplex': {
    API_KEY: ['DOUBAO_API_KEY', 'SEEDUPLEX_API_KEY', 'VOLCENGINE_DOUBAO_API_KEY'], URL: ['DOUBAO_SEEDUPLEX_REALTIME_URL'],
    MODEL: ['DOUBAO_SEEDUPLEX_REALTIME_MODEL'], VOICE: ['DOUBAO_SEEDUPLEX_REALTIME_VOICE'],
  },
  'speech-to-speech': { API_KEY: ['SPEECH_TO_SPEECH_AUTH_TOKEN', 'S2S_API_KEY'], URL: ['SPEECH_TO_SPEECH_REALTIME_URL', 'S2S_REALTIME_URL'] },
  'minicpm-o': { API_KEY: ['MINICPM_O_AUTH_TOKEN'], URL: ['MINICPM_O_REALTIME_URL'] },
}

export function legacyOmniVoiceFromEnvironment(env, model = env.QWEN_AUDIO_REALTIME_MODEL) {
  return resolveDashScopeRealtimeModelProfile(model).family === 'omni'
    ? env.QWEN_OMNI_REALTIME_VOICE : undefined
}

export function legacyRealtimeEnvironment(env, provider, { deferModelVoice = false } = {}) {
  const result = {}
  for (const suffix of ['MODEL', 'API_KEY', 'URL', 'VOICE']) {
    const key = 'QWEN_AUDIO_REALTIME_' + suffix
    const source = [key, ...(LEGACY_FIELDS[provider]?.[suffix] || [])].find(name => env[name] !== undefined)
    if (source) result[key] = env[source]
  }
  if (provider === 'dashscope') {
    if (result.QWEN_AUDIO_REALTIME_URL === undefined && String(env.DASHSCOPE_WORKSPACE_ID || '').trim()) {
      result.QWEN_AUDIO_REALTIME_URL = 'wss://' + String(env.DASHSCOPE_WORKSPACE_ID).trim()
        + '.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime'
    }
    const omniVoice = deferModelVoice ? undefined : legacyOmniVoiceFromEnvironment(env)
    if (result.QWEN_AUDIO_REALTIME_VOICE === undefined && omniVoice !== undefined) {
      result.QWEN_AUDIO_REALTIME_VOICE = omniVoice
    }
  }
  return result
}
