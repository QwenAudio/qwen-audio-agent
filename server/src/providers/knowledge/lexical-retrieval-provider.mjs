import { assertKnowledgeStore } from '../../frontend/knowledge/knowledge-store.mjs'

function normalized(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function queryTerms(value) {
  const source = normalized(value)
  const terms = new Set()
  for (const match of source.matchAll(/[a-z0-9][a-z0-9_-]*/gu)) {
    if (match[0].length >= 2) terms.add(match[0])
  }
  for (const match of source.matchAll(/[\p{Script=Han}]+/gu)) {
    const sequence = [...match[0]]
    if (sequence.length <= 4) terms.add(sequence.join(''))
    if (sequence.length === 1) terms.add(sequence[0])
    for (let index = 0; index < sequence.length - 1; index += 1) {
      terms.add(sequence.slice(index, index + 2).join(''))
    }
  }
  return { source, terms: [...terms] }
}

function occurrences(source, term, limit = 4) {
  let count = 0
  let offset = 0
  while (count < limit) {
    const index = source.indexOf(term, offset)
    if (index < 0) break
    count += 1
    offset = index + Math.max(1, term.length)
  }
  return count
}

function relevance(query, terms, title, text) {
  const normalizedTitle = normalized(title)
  const normalizedText = normalized(text)
  let score = 0
  if (query && normalizedTitle.includes(query)) score += 30
  if (query && normalizedText.includes(query)) score += 15
  for (const term of terms) {
    const weight = Math.min(6, Math.max(1, [...term].length))
    score += occurrences(normalizedTitle, term, 2) * weight * 3
    score += occurrences(normalizedText, term) * weight
  }
  return score
}

export class LexicalKnowledgeRetrievalProvider {
  constructor({ store } = {}) {
    this.store = assertKnowledgeStore(store)
  }

  describe() {
    return {
      key: 'local-lexical',
      label: 'Local Lexical Knowledge Retrieval',
    }
  }

  isConfigured() {
    return true
  }

  async retrieve(query, {
    ownerId,
    documentIds = [],
    limit = 5,
    signal,
  } = {}) {
    if (signal?.aborted) throw signal.reason || new Error('Retrieval aborted')
    const owner = String(ownerId || '').trim()
    const parsed = queryTerms(query)
    if (!owner || (!parsed.source && !parsed.terms.length)) return { results: [] }
    const allowed = new Set(
      (documentIds || []).map(value => String(value || '').trim()).filter(Boolean),
    )
    const summaries = await this.store.listDocuments(owner)
    const documents = await Promise.all(summaries
      .filter(summary => !allowed.size || allowed.has(summary.id))
      .map(summary => this.store.getDocument(owner, summary.id)))
    const matches = []
    for (const document of documents) {
      if (signal?.aborted) throw signal.reason || new Error('Retrieval aborted')
      for (const chunk of document?.chunks || []) {
        const score = relevance(
          parsed.source,
          parsed.terms,
          document.title,
          chunk.text,
        )
        if (score <= 0) continue
        matches.push({
          documentId: document.id,
          chunkId: chunk.id,
          title: document.title,
          text: chunk.text,
          score,
          ordinal: chunk.ordinal,
        })
      }
    }
    matches.sort((left, right) => (
      right.score - left.score
      || left.title.localeCompare(right.title)
      || left.ordinal - right.ordinal
    ))
    return { results: matches.slice(0, Math.max(1, Math.min(8, limit))) }
  }
}
