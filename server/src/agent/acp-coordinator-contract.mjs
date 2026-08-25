import { inputAttachmentMetadata } from '../../../shared/input-parts.mjs'
import { canonicalScope, isDirectiveScope } from '../core/memory-scopes.mjs'
import { parseCoordinatorPayload } from './acp-backend-session-utils.mjs'
import { COORDINATOR_STABLE_INSTRUCTIONS } from './acp-coordinator-instructions.mjs'

function clean(value) {
  return String(value || '').trim()
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

export function buildAcpCoordinatorPrompt({
  originalRequest,
  objective,
  userMemories = [],
  conversationContext = [],
  timeZone = 'UTC',
  workingDirectory = '',
  workId = '',
  jobId = '',
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
  const requestId = clean(jobId) || clean(workId)
  const envelope = {
    protocol: 'qwen-audio-agent.coordination.v2',
    request_id: requestId,
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

export function acpCoordinatorResponseState(content) {
  return clean(parseCoordinatorPayload(content)?.state).toLowerCase()
}

export function parseAcpCoordinatorDecision(content, expectedJobId = '') {
  const parsed = parseCoordinatorPayload(content)
  return {
    jobId: clean(expectedJobId) || clean(parsed?.job_id) || clean(parsed?.work_id),
    presentation: normalizePresentation(
      parsed?.presentation,
      clean(parsed?.response) || clean(content),
    ),
  }
}

export function acpCoordinatorRetryPrompt(jobId, state) {
  return [
    '<qwen_audio_agent_protocol_retry>',
    `request_id=${clean(jobId)}`,
    `上一条响应返回了不受支持的 state=${clean(state)}，因此不能作为最终结果交付。`,
    '请继续完成同一个用户请求。只有工作真实完成后，才返回 state=completed 的最终响应；不要返回进度、受理确认或未来承诺。',
    '</qwen_audio_agent_protocol_retry>',
  ].join('\n')
}
