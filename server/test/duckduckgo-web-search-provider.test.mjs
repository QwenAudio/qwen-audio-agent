import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DuckDuckGoWebSearchProvider,
  parseDuckDuckGoResults,
} from '../src/providers/search/duckduckgo.mjs'

const SEARCH_HTML = `
  <div class="result">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Ffirst">
      First &amp; current
    </a>
    <a class="result__snippet">A <b>current</b> source.</a>
  </div>
  <div class="result">
    <a href="https://example.org/second" class="result__a">Second</a>
    <div class="result__snippet">Another source.</div>
  </div>
`

test('parses bounded DuckDuckGo HTML results into the Search Port shape', async () => {
  const requests = []
  const provider = new DuckDuckGoWebSearchProvider({
    fetchImpl: async (url, options) => {
      requests.push({ url, options })
      return new Response(SEARCH_HTML, { status: 200 })
    },
  })

  const result = await provider.search('latest facts', { limit: 1 })

  assert.equal(requests[0].url.origin, 'https://html.duckduckgo.com')
  assert.equal(requests[0].url.searchParams.get('q'), 'latest facts')
  assert.equal(requests[0].options.redirect, 'error')
  assert.deepEqual(result, {
    results: [{
      title: 'First & current',
      url: 'https://example.com/first',
      snippet: 'A current source.',
      source: 'example.com',
    }],
  })
})

test('detects challenge pages and empty result pages', async () => {
  const challenged = new DuckDuckGoWebSearchProvider({
    fetchImpl: async () => new Response('<form id="challenge-form">captcha</form>'),
  })
  await assert.rejects(
    challenged.search('facts'),
    error => error.code === 'search_challenge',
  )

  const empty = new DuckDuckGoWebSearchProvider({
    fetchImpl: async () => new Response('<p>No results.</p>'),
  })
  await assert.rejects(
    empty.search('facts'),
    error => error.code === 'search_results_missing',
  )
})

test('parses title links regardless of attribute ordering', () => {
  assert.equal(parseDuckDuckGoResults(SEARCH_HTML).length, 2)
})
