import { createHash } from 'node:crypto'
import { config } from '../../core/config.mjs'
import {
  realtimeModelCatalog,
  resolveRealtimeModelProfile,
} from '../../../../shared/realtime-model-catalog.mjs'
import { PERMISSION_DECISIONS } from '../../../../shared/permission-decisions.mjs'
import { resolveAssistantProfile } from '../../conversation/frontend-agent-context.mjs'
import {
  buildFrontendInstructions,
  frontendTools,
  inputRequestResponseInstructions,
  permissionResponseInstructions,
  progressResponseInstructions,
  resultResponseInstructions,
} from '../../frontend/frontend-tools.mjs'
import { isRecoverableRealtimeInactivityError } from '../realtime-errors.mjs'
import { frontendInputProjection, inputText } from '../../../../shared/input-parts.mjs'
import { clampCommentary, createGptLive1Protocol, estimateTokens, messageItem } from './gpt-live-1-protocol.mjs'

// OpenAI's full-duplex Live API (/v1/live/sessions), not the Realtime API behind
// `gpt-live`. The voice model delegates reasoning and tools to a Responses model.

function modelProfile() {
  return resolveRealtimeModelProfile(config.gptLive1Model, 'gpt-live-1')
}

// One line per tool, so the voice model knows what it can hand off.
function backendCapabilities(agentContext) {
  return frontendTools(agentContext).map(tool => (
    `- ${tool.function.name}: ${String(tool.function.description || '').trim() || 'backend action'}`
  ))
}

// Split as the Live guides ask: persona and policies here, task rules in the
// backend prompt.
function voiceInstructions(agentContext) {
  return [
    'You are the spoken voice of a personal assistant. Speak naturally and',
    'briefly, in the language the user speaks. Be clear and direct.',
    '',
    'Backchannel policy: Use moderate backchannels. Acknowledge naturally',
    'without competing with the main response.',
    '',
    'Interruption policy: Stop speaking when the user interrupts. Listen to',
    'what they say.',
    '',
    'Delegation policy:',
    'Backend tools:',
    ...backendCapabilities(agentContext),
    '',
    'Delegate to the backend when:',
    '- The request needs facts, tools, memory, schedules, files or any action.',
    '- A correction changes work already requested.',
    '- The user answers a question the backend asked, for example a permission request.',
    '- The answer needs careful reasoning beyond a brief reply.',
    '',
    'Do not delegate to the backend when:',
    '- You can answer from the conversation or a still-current backend result.',
    '- You need a brief clarification to understand the request.',
    '',
    'Delegate before giving an answer that depends on backend work.',
    'Do not guess the result while waiting; say briefly that you are checking.',
    'Only report an action as done when the backend result says it succeeded.',
    '',
    '# Assistant Profile',
    '<assistant_profile authority="persona_only">',
    resolveAssistantProfile(agentContext),
    '</assistant_profile>',
  ].join('\n')
}

// Fixed guidance for injected items, stated once in the backend prompt.
const GATEWAY_MESSAGES = [
  ['A final result of earlier work', resultResponseInstructions],
  ['A progress update of earlier work', progressResponseInstructions],
  ['A <permission_request> block', permissionResponseInstructions],
  ['A follow-up question from running work', inputRequestResponseInstructions],
]

function delegationInstructions(agentContext) {
  return [
    '## Voice conversation context',
    'You are the reasoning backend of a live voice assistant. Transcripts can',
    'contain mistakes, unfinished phrases and later corrections. Use the latest',
    'context and verified tool results. If a needed detail is unclear, ask for',
    'that detail instead of guessing.',
    '',
    '## Task instructions',
    buildFrontendInstructions(agentContext),
    '',
    '## Gateway messages',
    'Some user-role items are inserted by the Gateway, not spoken by the user.',
    'Recognise them by their shape and handle each as follows, without calling',
    'tools: any reply from the user comes in a later turn.',
    ...GATEWAY_MESSAGES.map(([shape, text]) => `- ${shape}: ${text}`),
    '',
    '## Return the result',
    'Return the relevant facts, the task status and the next step, concisely,',
    'for the voice layer to speak. Report an action as complete only after the',
    'tool confirms it. If the outcome is unclear, say so and what to check.',
  ].join('\n')
}

// Startup history: session.input takes up to 128 messages and 8,192 tokens; the
// estimate is rough, so keep a margin.
const SESSION_INPUT_MAX_MESSAGES = 64
const SESSION_INPUT_TOKEN_BUDGET = 6144

export function sessionInputHistory(messages = []) {
  const selected = []
  let used = 0
  for (const message of [...(Array.isArray(messages) ? messages : [])].reverse()) {
    const role = message?.role === 'assistant' ? 'assistant' : message?.role === 'user' ? 'user' : ''
    const text = typeof message?.content === 'string' ? message.content.trim() : ''
    if (!role || !text) continue
    const tokens = estimateTokens(text)
    if (used + tokens > SESSION_INPUT_TOKEN_BUDGET || selected.length >= SESSION_INPUT_MAX_MESSAGES) break
    selected.unshift(messageItem(role, text))
    used += tokens
  }
  return selected
}

function delegationTools(agentContext) {
  return frontendTools(agentContext).map(tool => ({
    type: 'function',
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  }))
}

// Histories the service refused at startup, by content: only a retry with the
// same history omits it (every connection shares this module).
const REJECTED_HISTORY_LIMIT = 16
const rejectedHistories = new Set()

function historyKey(input) {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex')
}

function rememberRejectedHistory(input) {
  if (!Array.isArray(input) || !input.length) return
  rejectedHistories.add(historyKey(input))
  while (rejectedHistories.size > REJECTED_HISTORY_LIMIT) {
    rejectedHistories.delete(rejectedHistories.values().next().value)
  }
}

function seededHistory(recentMessages) {
  const input = sessionInputHistory(recentMessages)
  if (input.length && rejectedHistories.delete(historyKey(input))) return []
  return input
}

export const gptLive1Provider = {
  key: 'gpt-live-1',
  label: 'GPT-Live 1',
  aliases: ['gptlive1', 'openai-live'],
  // Live API input and output are both raw mono PCM16 at 24 kHz.
  inputSampleRate: 24000,
  outputSampleRate: 24000,
  createProtocol: context => createGptLive1Protocol({
    ...config.gptLive1Timing,
    ...context,
    standingInstructions: GATEWAY_MESSAGES.map(([, text]) => text),
    onStartupError: (error, { session } = {}) => {
      if (/^(session\.)?input\b/.test(String(error?.param || ''))) rememberRejectedHistory(session?.input)
    },
  }),
  capabilities: {
    // session.started is the only startup acknowledgement.
    acknowledgesSessionUpdate: false,
    // Only the delegation block may change after session.start.
    mutableSession: true,
    // The Live API echoes no receipt for an item.
    conversationItemIdEcho: false,
    acknowledgesConversationItems: false,
    // History goes into session.input at startup.
    restoreConversationContext: false,
    // response.create carries no instructions; they travel as a backend item.
    perResponseInstructions: false,
    sessionOutputVoice: true,
    concurrentVoicePlayback: true,
    transcriptTrailsAudio: true,
    toolOutputsBeforeResponse: true,
  },

  model: () => config.gptLive1Model,
  modelProfile,
  // A deployment name joins the catalog so clients can match its capabilities.
  modelCatalog: () => {
    const profiles = realtimeModelCatalog('gpt-live-1').profiles
    const active = modelProfile()
    return profiles.some(profile => profile.id === active.id) ? profiles : [...profiles, active]
  },
  voice: () => config.gptLive1Voice || null,
  isConfigured: () => Boolean(config.gptLive1ApiKey),
  missingConfigurationMessage: '请先配置 GPT_LIVE_1_API_KEY',
  connectTimeoutMessage: '连接 GPT-Live 1 Live API 超时',
  url: () => config.gptLive1RealtimeUrl,
  headers: () => ({ Authorization: `Bearer ${config.gptLive1ApiKey}` }),
  // A rejected command (session.update, an append) fails only itself.
  classifyError: message => {
    if (isRecoverableRealtimeInactivityError(message)) return 'inactivity'
    // Session capacity only; a failed backend response fails its turn.
    if (/unexpected server response: 429|too many (?:concurrent )?sessions|concurrent[_ -]?sessions?/i.test(message)) return 'capacity_busy'
    // The key is checked at the handshake; a later auth error fails only the turn.
    if (/invalid[_ -]?api[_ -]?key|unexpected server response: (?:401|403)|model[_ -]?not[_ -]?(?:found|deployed)/i.test(message)) return 'fatal'
    // Only a close for content is recovered; other moderation cuts only speech.
    if (/\bsession_closed\b/.test(message)) return 'content_safety'
    return 'other'
  },

  buildSession: ({ agentContext, sessionOptions }) => {
    const voice = String(sessionOptions?.voice || config.gptLive1Voice || '').trim()
    const input = seededHistory(agentContext?.recentMessages)
    return {
      model: config.gptLive1Model,
      instructions: voiceInstructions(agentContext),
      ...(input.length ? { input } : {}),
      ...(voice ? { audio: { output: { voice } } } : {}),
      delegation: {
        type: 'responses',
        responses: {
          model: config.gptLive1DelegationModel || 'gpt-6-luna',
          instructions: delegationInstructions(agentContext),
          tools: delegationTools(agentContext),
          tool_choice: 'auto',
          parallel_tool_calls: true,
        },
      },
    }
  },

  // Typed text goes to the backend; the voice layer is told to wait and speak its answer.
  projectUserInput: ({ parts, options, protocol }) => {
    const content = frontendInputProjection(parts, options)
    if (!content) return null
    const typed = options?.contextOnly === false && inputText(parts)
    return {
      ...(typed ? { beforeEvents: [{ type: 'session.thinking.append', delegation_id: null, content: clampCommentary(`The user typed this message. The backend is answering it: wait for that answer, then speak it in the message's language. Message: ${typed}`) }] } : {}),
      conversationItem: protocol.userTextItem(content),
    }
  },

  // Spoken directly by the voice layer as a commentary append.
  buildSpeakResponse: content => ({ __liveSay: content }),

  // Results and permission requests go to the backend; the voice layer speaks the reply, even after a stop.
  buildResultInjection: content => ({
    item: messageItem('user', content),
    response: { __liveAnnounce: true },
  }),

  buildPermissionInjection: permission => ({
    item: messageItem('user', [
      '<permission_request>',
      `permission_id=${permission.id}`,
      `task_id=${permission.taskId}`,
      `operation=${permission.summary}`,
      `allowed_decisions=${PERMISSION_DECISIONS.join(',')}`,
      '</permission_request>',
    ].join('\n')),
    response: { __liveAnnounce: true },
  }),
}
