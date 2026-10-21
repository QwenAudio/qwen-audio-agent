import { providerRuntimeConfiguration } from './runtime-configuration.mjs'
import { buildFrontendInstructions } from '../../frontend/frontend-tools.mjs'
import { createMiniCpmOProtocol } from './minicpm-o-protocol.mjs'

const connection = providerRuntimeConfiguration('minicpm-o')

const MODEL_ID = 'openbmb/MiniCPM-o-4_5'

const MODEL_CAPABILITIES = Object.freeze({
  textInput: true,
  audioInput: true,
  imageInput: true,
  videoInput: true,
  textOutput: true,
  audioOutput: true,
  functionCalling: false,
})

function videoModeEnabled(value = connection.endpoint) {
  try {
    return new URL(value).searchParams.get('mode') === 'video'
  } catch {
    return false
  }
}

function modelProfile() {
  const imageBufferInput = videoModeEnabled()
  return Object.freeze({
    id: MODEL_ID,
    label: 'MiniCPM-o 4.5',
    family: 'minicpm-o',
    sessionDefaults: Object.freeze({
      voice: null,
      turnDetection: null,
    }),
    modelCapabilities: MODEL_CAPABILITIES,
    transportCapabilities: Object.freeze({
      textInput: false,
      audioInput: true,
      imageInput: false,
      imageBufferInput,
    }),
  })
}

function classifyError(message) {
  if (/queue[_ -]?full|session.*queued|no available worker/i.test(message)) {
    return 'capacity_busy'
  }
  if (/unauthorized|forbidden|unexpected server response: (?:401|403)/i.test(message)) {
    return 'fatal'
  }
  return 'other'
}

export const miniCpmOProvider = {
  key: 'minicpm-o',
  label: 'ModelBest',
  aliases: ['minicpmo'],
  inputSampleRate: 16000,
  outputSampleRate: 24000,
  connectTimeoutMs: 300_000,
  responseStartTimeoutMs: 120_000,
  createProtocol: createMiniCpmOProtocol,

  capabilities: {
    acknowledgesSessionUpdate: true,
    conversationItems: false,
    clientResponses: false,
    mutableSession: false,
  },

  model: () => MODEL_ID,
  modelProfile,
  voice: () => null,
  isConfigured: () => connection.configured,
  missingConfigurationMessage: '请先选择 minicpm-o 并配置 QWEN_AUDIO_REALTIME_URL',
  connectTimeoutMessage: '连接面壁智能 Realtime 服务超时，请检查服务地址和运行状态',
  url: () => connection.endpoint,
  headers: () => connection.credential
    ? { Authorization: `Bearer ${connection.credential}` }
    : {},
  classifyError,

  buildSession: ({ agentContext }) => ({
    instructions: buildFrontendInstructions(agentContext),
  }),

  buildSpeakResponse: content => ({ content }),
  buildResultInjection: content => ({ item: { content }, response: {} }),
  buildPermissionInjection: permission => ({ item: permission, response: {} }),
}
