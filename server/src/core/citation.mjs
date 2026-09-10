function cleanText(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

export function normalizePublicUrl(value) {
  let url
  try {
    url = new URL(String(value || '').trim())
  } catch {
    return null
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    return null
  }
  url.hash = ''
  return url.toString()
}

export function normalizeCitation(input = {}, { id = 'source_1' } = {}) {
  const url = normalizePublicUrl(input.url)
  if (!url) return null
  const title = cleanText(input.title, 300) || new URL(url).hostname
  const snippet = cleanText(
    input.snippet ?? input.description ?? input.content,
    1200,
  )
  const source = cleanText(input.source, 120)
  const publishedAt = cleanText(
    input.publishedAt ?? input.published_at,
    80,
  )
  return {
    id: cleanText(id, 40) || 'source_1',
    title,
    url,
    ...(snippet ? { snippet } : {}),
    ...(source ? { source } : {}),
    ...(publishedAt ? { published_at: publishedAt } : {}),
  }
}

/**
 * Projects provider-specific search output into the frontend citation model.
 * Provider metadata stays behind the boundary; the model only sees bounded
 * factual snippets and stable citation references.
 */
export function normalizeSearchResponse(response, { query, limit = 5 } = {}) {
  const rawResults = Array.isArray(response)
    ? response
    : Array.isArray(response?.results)
      ? response.results
      : []
  const citations = []
  const results = []
  const seen = new Set()
  for (const candidate of rawResults) {
    if (results.length >= limit) break
    const citation = normalizeCitation(candidate, {
      id: `source_${results.length + 1}`,
    })
    if (!citation || seen.has(citation.url)) continue
    seen.add(citation.url)
    citations.push(citation)
    results.push({
      title: citation.title,
      url: citation.url,
      snippet: citation.snippet || '',
      citation_id: citation.id,
      ...(citation.source ? { source: citation.source } : {}),
      ...(citation.published_at
        ? { published_at: citation.published_at }
        : {}),
    })
  }
  const summary = String(response?.summary || '').trim().slice(0, 8000)
  return {
    status: 'ok',
    query: cleanText(query, 500),
    ...(summary ? { summary } : {}),
    results,
    citations,
  }
}
