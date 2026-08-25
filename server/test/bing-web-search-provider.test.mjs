import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BingWebSearchProvider,
  parseBingRssResults,
} from '../src/providers/search/bing.mjs'

const SEARCH_RSS = `<?xml version="1.0" encoding="utf-8" ?>
<rss version="2.0"><channel>
  <item>
    <title>First &amp; current</title>
    <link>https://example.com/first</link>
    <description>A current source.</description>
  </item>
  <item>
    <title>Second</title>
    <link>https://example.org/second</link>
    <description>Another source.</description>
  </item>
</channel></rss>`

test('parses bounded Bing RSS results into the Search Port shape', async () => {
  const requests = []
  const provider = new BingWebSearchProvider({
    fetchImpl: async (url, options) => {
      requests.push({ url, options })
      return new Response(SEARCH_RSS, {
        status: 200,
        headers: { 'content-type': 'text/xml; charset=utf-8' },
      })
    },
  })

  const result = await provider.search('latest facts', { limit: 1 })

  assert.equal(requests[0].url.origin, 'https://www.bing.com')
  assert.equal(requests[0].url.searchParams.get('q'), 'latest facts')
  assert.equal(requests[0].url.searchParams.get('format'), 'rss')
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

test('rejects non-RSS and empty RSS responses', async () => {
  const invalid = new BingWebSearchProvider({
    fetchImpl: async () => new Response('<html>Search page</html>'),
  })
  await assert.rejects(
    invalid.search('facts'),
    error => error.code === 'search_response_invalid',
  )

  const empty = new BingWebSearchProvider({
    fetchImpl: async () => new Response('<rss><channel></channel></rss>'),
  })
  await assert.rejects(
    empty.search('facts'),
    error => error.code === 'search_results_missing',
  )
})

test('drops malformed and credential-bearing result URLs', () => {
  const xml = SEARCH_RSS.replace(
    'https://example.com/first',
    'https://user:secret@example.com/first',
  )
  assert.equal(parseBingRssResults(xml).length, 1)
})
