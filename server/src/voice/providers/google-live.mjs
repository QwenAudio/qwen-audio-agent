import { providerRuntimeConfiguration } from './runtime-configuration.mjs'
import { config } from '../../core/config.mjs'
import {
  realtimeModelCatalog,
  resolveRealtimeModelProfile,
} from '../../../../shared/realtime-model-catalog.mjs'
import { PERMISSION_DECISIONS } from '../../../../shared/permission-decisions.mjs'
import {
  buildFrontendInstructions,
  frontendTools,
  permissionResponseInstructions,
  resultResponseInstructions,
  speakResponseInstructions,
} from '../../frontend/frontend-tools.mjs'
import { createGoogleLiveProtocol } from './google-live-protocol.mjs'

const connection = providerRuntimeConfiguration('google-live')

function modelProfile() {
  return resolveRealtimeModelProfile(connection.model, 'google-live', config.realtimeModelCatalogs)
}

function googleLiveUrl() {
  const url = new URL(connection.endpoint)
  if (!url.searchParams.has('key') && !url.searchParams.has('access_token')) {
    url.searchParams.set('key', connection.credential)
  }
  return url.toString()
}

function googleToolDeclarations(agentContext) {
  const declarations = frontendTools(agentContext)
    .map(tool => tool.function)
    .filter(tool => tool?.name)
    .map(tool => ({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      ...(tool.parameters ? { parameters: tool.parameters } : {}),
    }))
  return declarations.length ? [{ functionDeclarations: declarations }] : []
}

function speechConfig(voice) {
  const voiceName = String(voice || '').trim()
  return voiceName
    ? { voiceConfig: { prebuiltVoiceConfig: { voiceName } } }
    : undefined
}

function userTextItem(text) {
  return {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text }],
  }
}

export const googleLiveProvider = {
  key: 'google-live',
  label: 'Google Live',
  aliases: ['google', 'gemini-live', 'googlelive'],
  inputSampleRate: 16000,
  outputSampleRate: 24000,
  createProtocol: createGoogleLiveProtocol,
  capabilities: {
    acknowledgesConversationItems: false,
    automaticToolResponses: true,
    singleResponseSlot: true,
    conversationItemIdEcho: false,
    perResponseInstructions: false,
    sessionOutputVoice: true,
    mutableSession: false,
  },

  model: () => connection.model,
  modelProfile,
  modelCatalog: () => realtimeModelCatalog('google-live', config.realtimeModelCatalogs).profiles,
  voice: () => String(connection.voice || '').trim() || modelProfile().sessionDefaults.voice,
  isConfigured: () => connection.configured,
  missingConfigurationMessage: '请先选择 google-live 并配置 QWEN_AUDIO_REALTIME_API_KEY',
  connectTimeoutMessage: '连接 Google Live 超时',
  url: googleLiveUrl,
  headers: () => ({}),
  classifyError: message => {
    if (/unauthenticated|permission[_ ]denied|api key|unexpected server response: (?:401|403)/i.test(message)) return 'fatal'
    if (/cancel|no active response/i.test(message)) return 'no_active_response'
    if (/resource exhausted|rate limit|quota/i.test(message)) return 'fatal'
    if (/safety|policy|blocked/i.test(message)) return 'content_safety'
    return 'other'
  },

  buildSession: ({ agentContext, sessionOptions }) => {
    const voice = String(sessionOptions?.voice || '').trim() || googleLiveProvider.voice()
    const configuredSpeech = speechConfig(voice)
    return {
      model: connection.model.startsWith('models/')
        ? connection.model
        : `models/${connection.model}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        ...(configuredSpeech ? { speechConfig: configuredSpeech } : {}),
      },
      systemInstruction: {
        parts: [{ text: buildFrontendInstructions(agentContext) }],
      },
      tools: googleToolDeclarations(agentContext),
      outputAudioTranscription: {},
      inputAudioTranscription: {},
    }
  },

  buildSpeakResponse: content => ({
    modalities: ['audio'],
    instructions: speakResponseInstructions(content),
  }),

  buildResultInjection: content => ({
    item: userTextItem(`${resultResponseInstructions}\n\n${content}`),
    response: { modalities: ['audio'] },
  }),

  buildPermissionInjection: permission => ({
    item: userTextItem([
      permissionResponseInstructions,
      '<permission_request>',
      `permission_id=${permission.id}`,
      `task_id=${permission.taskId}`,
      `operation=${permission.summary}`,
      `allowed_decisions=${PERMISSION_DECISIONS.join(',')}`,
      '</permission_request>',
    ].join('\n')),
    response: { modalities: ['audio'] },
  }),
}
