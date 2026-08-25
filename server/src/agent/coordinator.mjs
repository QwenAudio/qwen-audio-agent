import { agent } from './agent-client.mjs'
import { promptWithInputParts } from './acp-content.mjs'
import { inputAttachmentMetadata } from '../../../shared/input-parts.mjs'
import { parseCoordinatorPayload } from './acp-backend-session-utils.mjs'
import { COORDINATOR_STABLE_INSTRUCTIONS } from './coordinator-instructions.mjs'
import { canonicalScope, isDirectiveScope } from '../core/memory-scopes.mjs'

const INLINE_SCHEMA = {
  anyOf: [
    { type: 'null' },
    {
      type: 'object',
      properties: {
        title: { type: 'string' },
        format: { type: 'string', enum: ['markdown', 'code', 'link'] },
        content: { type: 'string' },
      },
      required: ['title', 'format', 'content'],
      additionalProperties: false,
    },
  ],
}

const PRESENTATION_SCHEMA = {
  type: 'object',
  properties: {
    speech: { type: 'string' },
    inline: INLINE_SCHEMA,
  },
  required: ['speech', 'inline'],
  additionalProperties: false,
}

export const COORDINATOR_DECISION_SCHEMA = {
  type: 'object',
  oneOf: [
    {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        state: { type: 'string', enum: ['completed'] },
        mode: { type: 'string', enum: ['respond'] },
        presentation: PRESENTATION_SCHEMA,
      },
      required: ['job_id', 'state', 'mode', 'presentation'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        state: { type: 'string', enum: ['delegated'] },
        mode: { type: 'string', enum: ['delegate'] },
        delegation_id: { type: 'string' },
        target_session_id: { type: 'string' },
        presentation: PRESENTATION_SCHEMA,
      },
      required: [
        'job_id',
        'state',
        'mode',
        'delegation_id',
        'target_session_id',
        'presentation',
      ],
      additionalProperties: false,
    },
  ],
}

export const NATIVE_COORDINATOR_DECISION_SCHEMA = COORDINATOR_DECISION_SCHEMA

function clean(value) {
  return String(value || '').trim()
}

function coordinatorPayload(content) {
  return parseCoordinatorPayload(content)
}

export function coordinatorResponseState(content) {
  return clean(coordinatorPayload(content)?.state).toLowerCase()
}

function normalizeInline(value) {
  if (!value || typeof value !== 'object') return null
  const content = clean(value.content)
  if (!content) return null
  return {
    title: clean(value.title).slice(0, 120),
    format: ['markdown', 'code', 'link'].includes(value.format)
      ? value.format
      : 'markdown',
    content,
  }
}

function normalizePresentation(value, fallback = '') {
  const presentation = value && typeof value === 'object' ? value : {}
  return {
    speech: clean(presentation.speech) || clean(fallback),
    inline: normalizeInline(presentation.inline),
  }
}

export function parseCoordinatorDecision(content, expectedJobId = '') {
  const parsed = coordinatorPayload(content)
  return {
    jobId: clean(expectedJobId) || clean(parsed?.job_id) || clean(parsed?.work_id),
    state: 'completed',
    mode: 'respond',
    presentation: normalizePresentation(
      parsed?.presentation,
      clean(parsed?.response) || clean(content),
    ),
    task: null,
    targetSession: null,
  }
}

function contextLines(messages = []) {
  return messages
    .slice(-10)
    .map(message => {
      const role = message?.role === 'assistant' ? '助手' : '用户'
      const content = clean(message?.content).slice(0, 1000)
      return content ? `${role}: ${content}` : ''
    })
    .filter(Boolean)
    .join('\n')
}

export function buildCoordinatorPrompt({
  originalRequest,
  objective,
  userMemories = [],
  conversationContext = [],
  timeZone = 'UTC',
  workingDirectory = '',
  coordinationRunId = '',
  coordinationRequestId = '',
  inputParts = [],
  includeStableInstructions = true,
}) {
  const userModel = userMemories
    .filter(memory => isDirectiveScope(clean(memory.scope)))
    .map(memory => memory.format === 'markdown'
      ? clean(memory.content)
      : `- ${clean(memory.content)}`)
  const memoryRecords = userMemories
    .filter(memory => canonicalScope(clean(memory.scope)) === 'memory')
    .slice(0, 20)
  const memories = memoryRecords.length
    ? memoryRecords.map(memory => memory.format === 'markdown'
      ? clean(memory.content)
      : `- [${canonicalScope(clean(memory.scope)) || 'memory'}] ${clean(memory.content)}`
    ).join('\n\n')
    : ''
  const recentContext = contextLines(conversationContext)
  const envelope = {
    protocol: 'qwen-audio-agent.coordination.v2',
    request_id: clean(coordinationRequestId) || clean(coordinationRunId),
    timestamp: new Date().toISOString(),
    timezone: clean(timeZone) || 'UTC',
    ...(clean(workingDirectory)
      ? { client_context: { working_directory: clean(workingDirectory) } }
      : {}),
    input: {
      final_asr: clean(originalRequest),
      objective: clean(objective),
      ...(inputAttachmentMetadata(inputParts).length
        ? { attachments: inputAttachmentMetadata(inputParts) }
        : {}),
    },
  }

  return [
    '<qwen_audio_agent_request>',
    JSON.stringify(envelope, null, 2),
    '</qwen_audio_agent_request>',
    ...(userModel.length
      ? [`<user_preferences>\n${userModel.join('\n')}\n</user_preferences>`]
      : []),
    ...(memories ? [`<user_memory>\n${memories}\n</user_memory>`] : []),
    ...(recentContext
      ? [`<recent_voice_context>\n${recentContext}\n</recent_voice_context>`]
      : []),
    ...(includeStableInstructions
      ? ['', COORDINATOR_STABLE_INSTRUCTIONS]
      : []),
  ].join('\n')
}

export class Coordinator {
  constructor({ client = agent } = {}) {
    this.client = client
  }

  async run(input, options = {}) {
    const requestId = clean(options.coordinationRequestId)
      || clean(options.coordinationRunId)
    const prompt = buildCoordinatorPrompt({
      ...input,
      coordinationRunId: options.coordinationRunId,
      coordinationRequestId: requestId,
      includeStableInstructions:
        this.client.coordinatorUsesMcpInstructions?.() !== true,
    })
    const initialMessage = promptWithInputParts(prompt, input.inputParts)
    const run = message => this.client.runCoordinator
      ? this.client.runCoordinator(message, {
          ownerId: options.ownerId,
          voiceTaskId: options.sessionId,
          coordinationRunId: options.coordinationRunId,
          coordinationRequestId: requestId,
          signal: options.signal,
          outputSchema: COORDINATOR_DECISION_SCHEMA,
          onEvent: options.onEvent,
        })
      : Promise.reject(new Error('Coordinator backend is unavailable'))
    let result = await run(initialMessage)
    if (!clean(result?.content)) {
      throw new Error('Coordinator backend returned an empty response')
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const state = coordinatorResponseState(result.content)
      if (!state || state === 'completed') break
      result = await run([
        '<qwen_audio_agent_protocol_retry>',
        `request_id=${requestId}`,
        `上一条响应返回了不受支持的 state=${state}，因此不能作为最终结果交付。`,
        '请继续完成同一个用户请求。只有工作真实完成后，才返回 state=completed 的最终响应；不要返回进度、受理确认或未来承诺。',
        '</qwen_audio_agent_protocol_retry>',
      ].join('\n'))
    }
    const finalState = coordinatorResponseState(result.content)
    if (finalState && finalState !== 'completed') {
      throw new Error(`Coordinator did not return a final result (state=${finalState})`)
    }
    const decision = parseCoordinatorDecision(
      result.content,
      requestId,
    )
    return {
      content: decision.presentation.speech,
      metadata: {
        presentation: decision.presentation,
      },
    }
  }

  cancelWork(workId, options = {}) {
    if (!this.client.cancelWork) {
      return Promise.reject(new Error('Coordinator backend cannot cancel work'))
    }
    return this.client.cancelWork(workId, options)
  }

  async queryDelegatedWork(workId, question, options = {}) {
    if (!this.client.queryDelegatedWork) {
      throw new Error('Coordinator backend cannot query delegated work')
    }
    const result = await this.client.queryDelegatedWork(
      workId,
      question,
      options,
    )
    const decision = parseCoordinatorDecision(result.content, workId)
    return {
      content: decision.presentation.speech,
      metadata: {
        presentation: decision.presentation,
      },
    }
  }
}

export const coordinator = new Coordinator()
