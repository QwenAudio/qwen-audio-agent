function displayCitation(citation) {
  if (!citation?.title || !citation?.url) return null
  let url
  try {
    url = new URL(citation.url)
  } catch {
    return null
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    return null
  }
  return {
    title: String(citation.title).replace(/\s+/g, ' ').trim(),
    url: url.toString(),
  }
}

export function formatCitationLines(citations, { heading = '来源' } = {}) {
  const seen = new Set()
  const lines = []
  for (const candidate of Array.isArray(citations) ? citations : []) {
    const citation = displayCitation(candidate)
    if (!citation?.title || seen.has(citation.url)) continue
    seen.add(citation.url)
    lines.push(`  [${lines.length + 1}] ${citation.title} — ${citation.url}`)
    if (lines.length >= 16) break
  }
  return lines.length ? `${heading}\n${lines.join('\n')}` : ''
}
