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

function modelProfile() {
  return resolveRealtimeModelProfile(config.googleLiveModel, 'google-live')
}

function googleLiveUrl() {
  const url = new URL(config.googleLiveRealtimeUrl)
  if (!url.searchParams.has('key') && !url.searchParams.has('access_token')) {
    url.searchParams.set('key', config.googleApiKey)
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
    restoreConversationContext: false,
    singleResponseSlot: true,
    conversationItemIdEcho: false,
    perResponseInstructions: false,
    sessionOutputVoice: true,
    mutableSession: false,
  },

  model: () => config.googleLiveModel,
  modelProfile,
  modelCatalog: () => realtimeModelCatalog('google-live').profiles,
  voice: () => config.googleLiveVoice || null,
  isConfigured: () => Boolean(config.googleApiKey),
  missingConfigurationMessage: '请先配置 GOOGLE_API_KEY 或 GEMINI_API_KEY',
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
    const voice = String(sessionOptions?.voice || config.googleLiveVoice || '').trim()
    const configuredSpeech = speechConfig(voice)
    return {
      model: config.googleLiveModel.startsWith('models/')
        ? config.googleLiveModel
        : `models/${config.googleLiveModel}`,
      responseModalities: ['AUDIO'],
      systemInstruction: {
        parts: [{ text: buildFrontendInstructions(agentContext) }],
      },
      tools: googleToolDeclarations(agentContext),
      outputAudioTranscription: {},
      inputAudioTranscription: {},
      ...(configuredSpeech ? { speechConfig: configuredSpeech } : {}),
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
