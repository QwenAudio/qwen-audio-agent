import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BingWebSearchProvider,
  parseBingHtmlResults,
} from '../src/providers/search/bing.mjs'

const SEARCH_HTML = `<html><ol id="b_results">
<li class="b_algo" data-id iid=SERP.5329><div class="b_tpcn">chrome</div>
<h2 class=""><a target="_blank" href="https://example.com/first" h="ID=SERP,5143.2"><strong>First</strong> &amp; current</a></h2>
<div class="b_caption"><p class="b_lineclamp2">2026年5月7日&ensp;&#0183;&ensp;A current source with <strong>highlighted</strong> terms …</p></div></li>
<li class="b_algo"><h2><a href="https://example.org/second">Second</a></h2>
<div class="b_caption"><p>Another source.</p></div></li>
<li class="b_footerItems_icp"><h2><a href="https://footer.example/">footer</a></h2></li>
</ol></html>`

test('prefers the HTML web search page and parses b_algo results', async () => {
  const requests = []
  const provider = new BingWebSearchProvider({
    fetchImpl: async (url, options) => {
      requests.push({ url, options })
      return new Response(SEARCH_HTML, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    },
  })

  const result = await provider.search('latest facts', { limit: 5 })

  assert.equal(requests.length, 1)
  assert.equal(requests[0].url.origin, 'https://www.bing.com')
  assert.equal(requests[0].url.searchParams.get('q'), 'latest facts')
  assert.equal(requests[0].url.searchParams.get('format'), null)
  assert.equal(requests[0].options.redirect, 'error')
  assert.deepEqual(result, {
    results: [{
      title: 'First & current',
      url: 'https://example.com/first',
      snippet: '2026年5月7日 · A current source with highlighted terms …',
      source: 'example.com',
    }, {
      title: 'Second',
      url: 'https://example.org/second',
      snippet: 'Another source.',
      source: 'example.org',
    }],
  })
})

test('propagates an aborted request', async () => {
  const requests = []
  const controller = new AbortController()
  controller.abort()
  const provider = new BingWebSearchProvider({
    fetchImpl: async (url, options) => {
      requests.push(url)
      throw Object.assign(new Error('aborted'), { signal: options.signal })
    },
  })

  await assert.rejects(
    provider.search('facts', { signal: controller.signal }),
    error => error.code === 'search_aborted',
  )
  assert.equal(requests.length, 1)
})

test('rejects an HTML page without parsable search results', async () => {
  const invalid = new BingWebSearchProvider({
    fetchImpl: async () => new Response('<html>Search page</html>'),
  })
  await assert.rejects(
    invalid.search('facts'),
    error => error.code === 'search_results_missing',
  )
})

test('drops malformed and credential-bearing result URLs', () => {
  const html = SEARCH_HTML.replace(
    'https://example.com/first',
    'https://user:secret@example.com/first',
  )
  assert.equal(parseBingHtmlResults(html).length, 1)
})

test('tolerates invalid numeric entities in untrusted result markup', () => {
  const html = SEARCH_HTML.replace(
    'First</strong>',
    'First &#9999999999;</strong>',
  )
  assert.equal(parseBingHtmlResults(html)[0].title, 'First \ufffd & current')
})
