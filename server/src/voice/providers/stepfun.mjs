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
import { isRecoverableRealtimeInactivityError } from '../realtime-errors.mjs'
import { createStepFunProtocol } from './stepfun-protocol.mjs'
import { openAiCompatibleProtocol } from './openai-compatible-protocol.mjs'

function modelProfile() {
  return resolveRealtimeModelProfile(config.stepfunModel, 'stepfun')
}

export const stepfunProvider = {
  key: 'stepfun',
  label: 'StepFun Realtime',
  inputSampleRate: 24000,
  outputSampleRate: 24000,
  createProtocol: createStepFunProtocol,
  capabilities: {
    singleResponseSlot: true,
    // The service acknowledges client items with a newly assigned server id.
    conversationItemIdEcho: false,
    perResponseInstructions: false,
    sessionOutputVoice: true,
  },
  model: () => config.stepfunModel,
  modelProfile,
  modelCatalog: () => realtimeModelCatalog('stepfun').profiles,
  voice: () => config.stepfunVoice || null,
  isConfigured: () => Boolean(config.stepfunApiKey),
  missingConfigurationMessage: '请先配置 STEPFUN_API_KEY',
  connectTimeoutMessage: '连接 StepFun Realtime 超时',
  url: () => {
    const url = new URL(config.stepfunRealtimeUrl)
    url.searchParams.set('model', config.stepfunModel)
    return url.toString()
  },
  headers: () => ({ Authorization: `Bearer ${config.stepfunApiKey}` }),
  classifyError: message => {
    if (isRecoverableRealtimeInactivityError(message)) return 'inactivity'
    if (/another response is in progress|already has an active response/i.test(message)) return 'response_slot_busy'
    if (/no (?:active|ongoing) response|no response.*cancel/i.test(message)) return 'no_active_response'
    if (/invalid[_ -]?api[_ -]?key|authentication|unauthorized|forbidden|unexpected server response: (?:401|403)|model[_ -]?not[_ -]?found/i.test(message)) return 'fatal'
    return 'other'
  },

  buildSession: ({ configured, agentContext, sessionOptions }) => {
    const session = {
      instructions: buildFrontendInstructions(agentContext),
      // Only Gateway-managed functions. Do not register StepFun's built-in
      // { type: 'web_search' } or { type: 'retrieval' } tools.
      tools: frontendTools(agentContext),
    }
    if (!configured) {
      Object.assign(session, {
        modalities: ['text', 'audio'],
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        turn_detection: modelProfile().sessionDefaults.turnDetection,
      })
      const voice = String(sessionOptions?.voice || config.stepfunVoice || '').trim()
      if (voice) session.voice = voice
    }
    return session
  },

  buildSpeakResponse: content => ({
    modalities: ['text', 'audio'],
    instructions: speakResponseInstructions(content),
  }),

  buildResultInjection: content => ({
    item: openAiCompatibleProtocol.userTextItem(content),
    response: { modalities: ['text', 'audio'], instructions: resultResponseInstructions },
  }),

  buildPermissionInjection: permission => ({
    item: openAiCompatibleProtocol.userTextItem([
      '<permission_request>',
      `permission_id=${permission.id}`,
      `task_id=${permission.taskId}`,
      `operation=${permission.summary}`,
      `allowed_decisions=${PERMISSION_DECISIONS.join(',')}`,
      '</permission_request>',
    ].join('\n')),
    response: { modalities: ['text', 'audio'], instructions: permissionResponseInstructions },
  }),
}
