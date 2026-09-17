const SCOPE_LABELS = Object.freeze({
  user: '交互偏好',
  memory: '长期记忆',
})

const TRUNCATED_SUFFIX = '\n\n<!-- 内容过长，已截断；精确编辑前请缩小文档 -->'

function sourceContent(document) {
  return String(document?.content || '').replace(/\r\n?/gu, '\n')
}

function visibleLines(content) {
  let inComment = false
  return content.split('\n').map(raw => {
    let visible = ''
    let retained = ''
    let offset = 0
    while (offset < raw.length) {
      if (inComment) {
        const end = raw.indexOf('-->', offset)
        retained += raw.slice(offset, end < 0 ? raw.length : end + 3)
        offset = end < 0 ? raw.length : end + 3
        inComment = end < 0
      } else {
        const start = raw.indexOf('<!--', offset)
        visible += raw.slice(offset, start < 0 ? raw.length : start)
        offset = start < 0 ? raw.length : start
        inComment = start >= 0
      }
    }
    return { raw, visible: visible.trim(), retained }
  })
}

// Keep the existing exact-edit/revision contract. A displayed line can also
// occur in comments or another item, so widen the source span until unique and
// remove only the selected line's visible content, never every matching string.
export function memoryDeletionChange(documents, item) {
  const document = documents.find(candidate => candidate.scope === item?.scope)
  if (!document?.editable || !item?.revision || document.revision !== item.revision
    || !SCOPE_LABELS[document.scope]) {
    throw Object.assign(new Error('记忆已更新，请刷新后重新选择删除。'), { stale: true })
  }
  const snapshot = sourceContent(document)
  const truncated = snapshot.endsWith(TRUNCATED_SUFFIX)
  const content = truncated ? snapshot.slice(0, -TRUNCATED_SUFFIX.length) : snapshot
  const lines = visibleLines(content)
  const index = item.lineIndex
  const target = lines[index]
  if (!Number.isInteger(index) || !target?.visible || target.raw !== item.oldText
    || /^#{1,6}\s/u.test(target.visible)) {
    throw Object.assign(new Error('记忆条目已变化，请刷新后重新选择删除。'), { stale: true })
  }
  if (truncated && index === lines.length - 1) {
    throw new Error('这条记忆未完整加载，请在记忆文档中编辑后刷新。')
  }
  const chunks = lines.map((line, position) => line.raw + (position < lines.length - 1 ? '\n' : ''))
  const replacement = target.retained
    ? target.retained + (index < lines.length - 1 ? '\n' : '')
    : ''
  let start = index
  let end = index + 1
  while (true) {
    const oldText = chunks.slice(start, end).join('')
    if (content.indexOf(oldText) === content.lastIndexOf(oldText)) {
      return {
        document: document.scope,
        expectedRevision: item.revision,
        edits: [{
          old_text: oldText,
          new_text: chunks.slice(start, index).join('') + replacement + chunks.slice(index + 1, end).join(''),
        }],
      }
    }
    // Prefer preceding lines so truncated snapshots need not include their
    // synthetic suffix or unseen tail. The provider validates uniqueness again.
    if (start > 0) start -= 1
    else end += 1
  }
}

export function memoryItemsFromDocuments(documents = []) {
  const items = []
  for (const document of documents) {
    if (!document?.editable || !SCOPE_LABELS[document.scope]) continue
    let section = ''
    const lines = visibleLines(sourceContent(document))
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
        lineIndex: index,
        revision: document.revision,
      })
    }
  }
  return items
}
