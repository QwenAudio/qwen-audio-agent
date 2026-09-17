import { canonicalScope, isDirectiveScope } from './scopes.mjs'

// These existing document notices carry context semantics, not template facts.
// Preserve their exact legacy wording without adding rules to the system prompt.
const OBSERVED_NOTICE = '<!-- 以下为系统观察推断，权威低于上方用户明确要求；如与其冲突，以上方为准 -->'
const TRUNCATED_NOTICE = '<!-- 内容过长，已截断；精确编辑前请缩小文档 -->'

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function visibleContent(document) {
  const content = String(document?.content || '').trim()
  if (document?.format === 'text') return content

  // A truncation can end inside an unfinished template comment. Detach the
  // appended notice first so clearing that comment cannot swallow the warning.
  const truncated = content.endsWith(TRUNCATED_NOTICE)
  const body = truncated ? content.slice(0, -TRUNCATED_NOTICE.length) : content
  // Markdown template comments are editing guidance, not saved user facts.
  // Keep raw documents/revisions unchanged for the API and exact-edit tools.
  const visible = body.replace(/<!--[\s\S]*?(?:-->|$)/g, comment => (
    comment === OBSERVED_NOTICE ? comment : ''
  )).trim()
  return [visible, truncated ? TRUNCATED_NOTICE : ''].filter(Boolean).join('\n\n')
}

function userPreferencesSection(memories = []) {
  const document = memories.find(memory => (
    isDirectiveScope(clean(memory.scope))
  ))
  const content = visibleContent(document)
  if (!content) return ''
  const opening = document.revision
    ? `<user_preferences revision="${clean(document.revision)}">`
    : '<user_preferences>'
  return [
    opening,
    content,
    '</user_preferences>',
  ].join('\n')
}

function memorySection(memories = []) {
  const document = memories.find(memory => (
    canonicalScope(clean(memory.scope)) === 'memory'
  ))
  const content = visibleContent(document)
  if (!content) return ''
  const opening = document.revision
    ? `<user_memory revision="${clean(document.revision)}">`
    : '<user_memory>'
  return [
    opening,
    content,
    '</user_memory>',
  ].join('\n')
}

export function buildMemoryContext({ memories = [] } = {}) {
  return [userPreferencesSection(memories), memorySection(memories)].filter(Boolean).join('\n\n')
}
