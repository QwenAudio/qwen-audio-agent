import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeCitation, normalizeSearchResponse } from '../src/core/citation.mjs'

const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

test('keeps an emoji whole when a citation field reaches its limit', () => {
  const citation = normalizeCitation({
    url: 'https://example.com/a',
    title: `${'a'.repeat(299)}😀`,
    snippet: `${'b'.repeat(1199)}😀`,
    source: `${'c'.repeat(119)}😀`,
  })
  assert.equal(citation.title, 'a'.repeat(299))
  assert.equal(citation.snippet, 'b'.repeat(1199))
  assert.equal(citation.source, 'c'.repeat(119))
  assert.equal(loneSurrogate.test(JSON.stringify(citation)), false)
})

test('keeps an emoji whole when the query or summary reaches its limit', () => {
  const response = normalizeSearchResponse(
    { summary: `${'s'.repeat(7999)}😀`, results: [] },
    { query: `${'q'.repeat(499)}😀` },
  )
  assert.equal(response.query, 'q'.repeat(499))
  assert.equal(response.summary, 's'.repeat(7999))
})

test('still cuts plain text at the limit', () => {
  const citation = normalizeCitation({ url: 'https://example.com/a', title: 'x'.repeat(400) })
  assert.equal(citation.title.length, 300)
})
