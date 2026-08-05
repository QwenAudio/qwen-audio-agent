// Inline presentation is the screen half of a voice answer: the spoken half stays
// short while code, commands, links or long lists are rendered in the client
// timeline. Both producers share this contract — the coordinator returning a
// backend result and the front end calling show_inline — so a single format
// whitelist and title bound cannot drift apart between the two paths.

export const INLINE_FORMATS = Object.freeze(['markdown', 'code', 'link'])
export const INLINE_TITLE_MAX_CHARS = 120

export function normalizeInlinePresentation(value, { maxContentChars = 0 } = {}) {
  if (!value || typeof value !== 'object') return null
  const content = String(value.content || '').trim()
  if (!content) return null
  return {
    title: String(value.title || '').trim().slice(0, INLINE_TITLE_MAX_CHARS),
    format: INLINE_FORMATS.includes(value.format) ? value.format : 'markdown',
    content: maxContentChars > 0 ? content.slice(0, maxContentChars) : content,
  }
}
