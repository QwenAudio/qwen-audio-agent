import {
  normalizeCitation,
  normalizePublicUrl,
} from '../frontend/retrieval/citation.mjs'

/**
 * Correlates frontend retrieval sources with one user turn. Provider-local
 * source ids restart on every tool call; this store assigns one stable,
 * deduplicated sequence before the result reaches the model and later projects
 * that same sequence to the client-facing assistant transcript.
 */
export class TurnCitations {
  constructor({ maxTurns = 100, maxCitationsPerTurn = 16 } = {}) {
    this.maxTurns = maxTurns
    this.maxCitationsPerTurn = maxCitationsPerTurn
    this.turns = new Map()
  }

  #state(turnId) {
    const key = String(turnId || '').trim()
    if (!key) return null
    let state = this.turns.get(key)
    if (state) return state
    while (this.turns.size >= this.maxTurns) {
      this.turns.delete(this.turns.keys().next().value)
    }
    state = { citations: [], byUrl: new Map() }
    this.turns.set(key, state)
    return state
  }

  project(turnId, response) {
    const incoming = Array.isArray(response?.citations)
      ? response.citations
      : null
    if (!incoming) return response
    const state = this.#state(turnId)
    if (!state) return response
    const projected = []
    const currentUrls = new Set()
    for (const candidate of incoming) {
      const url = normalizePublicUrl(candidate?.url)
      if (!url || currentUrls.has(url)) continue
      currentUrls.add(url)
      let citation = state.byUrl.get(url)
      if (!citation && state.citations.length < this.maxCitationsPerTurn) {
        citation = normalizeCitation(candidate, {
          id: `source_${state.citations.length + 1}`,
        })
        if (citation) {
          state.citations.push(citation)
          state.byUrl.set(citation.url, citation)
        }
      }
      if (citation) projected.push({ ...citation })
    }
    const results = Array.isArray(response?.results)
      ? response.results.flatMap(result => {
          if (!String(result?.url || '').trim()) return [result]
          const url = normalizePublicUrl(result?.url)
          const citation = url && currentUrls.has(url)
            ? state.byUrl.get(url)
            : null
          return citation
            ? [{ ...result, url: citation.url, citation_id: citation.id }]
            : []
        })
      : null
    return {
      ...response,
      citations: projected,
      ...(results ? { results } : {}),
    }
  }

  consume(turnId) {
    const key = String(turnId || '').trim()
    const state = this.turns.get(key)
    if (!state) return []
    this.turns.delete(key)
    return state.citations.map(citation => ({ ...citation }))
  }

  clear() {
    this.turns.clear()
  }
}
