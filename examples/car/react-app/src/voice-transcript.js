export function finalUserTranscript(event) {
  if (event?.role !== 'user' || event.final !== true) return ''
  return String(event.content || '').replace(/\s+/gu, ' ').trim()
}
