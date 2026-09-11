const SCOPE_LABELS = Object.freeze({
  user: '交互偏好',
  memory: '长期记忆',
})

function visibleLines(content) {
  let inComment = false
  return String(content || '').split('\n').map(raw => {
    let visible = raw
    if (inComment) {
      const end = visible.indexOf('-->')
      if (end < 0) return { raw, visible: '' }
      visible = visible.slice(end + 3)
      inComment = false
    }
    while (visible.includes('<!--')) {
      const start = visible.indexOf('<!--')
      const end = visible.indexOf('-->', start + 4)
      if (end < 0) {
        visible = visible.slice(0, start)
        inComment = true
        break
      }
      visible = `${visible.slice(0, start)}${visible.slice(end + 3)}`
    }
    return { raw, visible: visible.trim() }
  })
}

export function memoryItemsFromDocuments(documents = []) {
  const items = []
  for (const document of documents) {
    if (!document?.editable || !SCOPE_LABELS[document.scope]) continue
    let section = ''
    const lines = visibleLines(document.content)
    for (let index = 0; index < lines.length; index += 1) {
      const { raw, visible } = lines[index]
      if (!visible) continue
      const heading = visible.match(/^#{2,6}\s+(.+)$/u)
      if (heading) {
        section = heading[1].trim()
        continue
      }
      if (/^#\s+/u.test(visible)) continue
      const bullet = visible.match(/^[-*+]\s+(.+)$/u)
      const text = (bullet?.[1] || visible).trim()
      if (!text) continue
      items.push({
        id: `${document.scope}:${document.revision}:${index}`,
        scope: document.scope,
        scopeLabel: SCOPE_LABELS[document.scope],
        section,
        text,
        oldText: raw,
        revision: document.revision,
      })
    }
  }
  return items
}
