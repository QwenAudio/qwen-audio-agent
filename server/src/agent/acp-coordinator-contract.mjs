import { backendInstructionFromWork } from '../backend/backend-work-input.mjs'
import { parseCoordinatorPayload } from './acp-backend-session-utils.mjs'
import { COORDINATOR_STABLE_INSTRUCTIONS } from './acp-coordinator-instructions.mjs'

function clean(value) {
  return String(value || '').trim()
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

export function buildAcpCoordinatorInstruction({
  includeStableInstructions = true,
  ...work
} = {}) {
  const instruction = backendInstructionFromWork(work)

  return [
    instruction,
    ...(includeStableInstructions
      ? ['', COORDINATOR_STABLE_INSTRUCTIONS]
      : []),
  ].filter(Boolean).join('\n')
}

export function acpCoordinatorResponseState(content) {
  return clean(parseCoordinatorPayload(content)?.state).toLowerCase()
}

export function parseAcpCoordinatorDecision(content) {
  const parsed = parseCoordinatorPayload(content)
  return {
    presentation: normalizePresentation(
      parsed?.presentation,
      clean(parsed?.response) || clean(content),
    ),
  }
}

export function acpCoordinatorRetryPrompt(state) {
  return [
    `上一条响应返回了不受支持的 state=${clean(state)}，因此不能作为最终结果交付。`,
    '请继续完成当前请求。只有工作真实完成后，才返回 state=completed 的最终响应；不要返回进度、受理确认或未来承诺。',
  ].join('\n')
}
