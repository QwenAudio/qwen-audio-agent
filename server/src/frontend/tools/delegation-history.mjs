const MAX_MESSAGES = 30
const MAX_MESSAGE_CHARS = 1_000
const MAX_TOTAL_CHARS = 12_000

// Capture the most recent customer turns with their intervening assistant
// replies. The snapshot is taken when work is accepted, not when a queued
// backend task eventually starts.
export function recentDelegationHistory(messages = [], turns = 0) {
  if (!Number.isInteger(turns) || turns <= 0) return []
  const visible = messages.filter(message =>
    ['user', 'assistant'].includes(message?.role)
    && typeof message.content === 'string'
    && message.content.trim())
  let start = visible.length
  let users = 0
  for (let index = visible.length - 1; index >= 0; index -= 1) {
    if (visible[index].role === 'user') users += 1
    if (users > turns) break
    start = index
  }
  if (!users) return []
  const selected = visible.slice(start).slice(-MAX_MESSAGES)
  const firstUser = selected.findIndex(message => message.role === 'user')
  if (firstUser < 0) return []
  const bounded = []
  let remaining = MAX_TOTAL_CHARS
  for (let index = selected.length - 1; index >= firstUser && remaining > 0; index -= 1) {
    const message = selected[index]
    const content = message.content.trim().slice(0, Math.min(MAX_MESSAGE_CHARS, remaining))
    if (!content) continue
    bounded.unshift({ role: message.role, content })
    remaining -= content.length
  }
  const firstBoundedUser = bounded.findIndex(message => message.role === 'user')
  return firstBoundedUser < 0 ? [] : bounded.slice(firstBoundedUser)
}
