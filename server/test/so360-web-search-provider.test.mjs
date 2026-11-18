import assert from 'node:assert/strict'
import test from 'node:test'
import {
  So360WebSearchProvider,
  parseSo360Results,
} from '../src/frontend/retrieval/providers/so360.mjs'

const SEARCH_HTML = `<html><ol id="main">
<li class="res-list"><h3 class="res-title " >
<a  href="https://www.so.com/link?m=abc" data-mdurl="http://www.sina.cn/news/detail/1.html"  rel="noopener" target="_blank"><em>王力宏</em>摔倒受伤|<em>王力宏</em>_新浪<em>新闻</em></a></h3>
<p class="res-desc"><span class="gray g-c-gray">2026年7月4日&nbsp;-&nbsp;</span><em>王力宏</em>在演唱会中摔倒导致脸和耳朵出血,粉丝批评团队疏忽</p>
<p class="g-linkinfo"><cite><a href="https://www.so.com/link?m=xyz">www.sina.cn</a></cite></p></li>
<li class="res-list"><h3 class="res-title">
<a href="https://example.org/plain" >Second result</a></h3>
<p class="res-desc">Another source.</p></li>
<li class="res-ad"><h3 class="res-title"><a href="https://ad.example/">ad</a></h3></li>
</ol></html>`

test('parses 360 result blocks and prefers data-mdurl over the redirect href', async () => {
  const requests = []
  const provider = new So360WebSearchProvider({
    fetchImpl: async (url, options) => {
      requests.push({ url, options })
      return new Response(SEARCH_HTML, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    },
  })

  const result = await provider.search('王力宏最近的新闻', { limit: 5 })

  assert.equal(requests.length, 1)
  assert.equal(requests[0].url.origin, 'https://www.so.com')
  assert.equal(requests[0].url.pathname, '/s')
  assert.equal(requests[0].url.searchParams.get('q'), '王力宏最近的新闻')
  assert.equal(requests[0].options.redirect, 'error')
  assert.deepEqual(result, {
    results: [{
      title: '王力宏摔倒受伤|王力宏_新浪新闻',
      url: 'http://www.sina.cn/news/detail/1.html',
      snippet: '2026年7月4日 - 王力宏在演唱会中摔倒导致脸和耳朵出血,粉丝批评团队疏忽',
      source: 'www.sina.cn',
    }, {
      title: 'Second result',
      url: 'https://example.org/plain',
      snippet: 'Another source.',
      source: 'example.org',
    }],
  })
})

test('rejects anti-spider challenge pages and empty result pages', async () => {
  const challenge = new So360WebSearchProvider({
    fetchImpl: async () => new Response(
      '<html><div id="antispider">请完成人机验证</div></html>',
    ),
  })
  await assert.rejects(
    challenge.search('facts'),
    error => error.code === 'search_challenge',
  )

  const empty = new So360WebSearchProvider({
    fetchImpl: async () => new Response('<html><div>没有相关结果</div></html>'),
  })
  await assert.rejects(
    empty.search('facts'),
    error => error.code === 'search_results_missing',
  )
})

test('propagates an aborted request', async () => {
  const controller = new AbortController()
  controller.abort()
  const provider = new So360WebSearchProvider({
    fetchImpl: async () => { throw new Error('aborted') },
  })
  await assert.rejects(
    provider.search('facts', { signal: controller.signal }),
    error => error.code === 'search_aborted',
  )
})

test('normalizes response body failures', async () => {
  const provider = new So360WebSearchProvider({
    fetchImpl: async () => ({
      ok: true,
      headers: new Headers(),
      text: async () => { throw new Error('broken response body') },
    }),
  })
  await assert.rejects(
    provider.search('facts'),
    error => error.code === 'search_request_failed',
  )
})

test('drops credential-bearing URLs and tolerates invalid numeric entities', () => {
  const withCredentials = SEARCH_HTML.replace(
    'http://www.sina.cn/news/detail/1.html',
    'https://user:secret@example.com/first',
  )
  assert.equal(parseSo360Results(withCredentials).length, 1)

  const withBadEntity = SEARCH_HTML.replace(
    '摔倒受伤',
    '摔倒 &#9999999999;受伤',
  )
  assert.ok(parseSo360Results(withBadEntity)[0].title.includes('\ufffd'))
})

test('decodes each entity once, so escaped entity text stays literal', () => {
  const html = SEARCH_HTML.replace('摔倒受伤', '摔倒 &amp;lt;b&amp;gt; 受伤')
  assert.ok(parseSo360Results(html)[0].title.includes('&lt;b&gt;'))
})

test('preserves unknown entities, including inherited object property names', () => {
  const text = '&constructor; &CONSTRUCTOR; &unknown;'
  const url = 'https://example.org/?value=&constructor;&amp;other=&unknown;'
  const html = SEARCH_HTML
    .replace('Second result', text)
    .replace('Another source.', text)
    .replace('http://www.sina.cn/news/detail/1.html', url)
    .replace('https://example.org/plain', url.replace('example.org', 'example.com'))
  const [first, second] = parseSo360Results(html)
  assert.equal(second.title, text)
  assert.equal(second.snippet, text)
  assert.equal(first.url, 'https://example.org/?value=&constructor;&other=&unknown;')
  assert.equal(second.url, 'https://example.com/?value=&constructor;&other=&unknown;')
})

test('decodes numeric entities once and preserves valid Unicode and invalid code point handling', () => {
  const text = '&amp;#60; &amp;#x3c; &#38;#x3c; &#x26;lt; &#60; &#x1F431; &#xD800; &#1114112;'
  const expected = '&#60; &#x3c; &#x3c; &lt; < 🐱 \ufffd \ufffd'
  const html = SEARCH_HTML
    .replace('Second result', text)
    .replace('Another source.', text)
  const result = parseSo360Results(html)[1]
  assert.equal(result.title, expected)
  assert.equal(result.snippet, expected)
})

test('decodes data-mdurl and href attribute entities only once', () => {
  const url = 'https://example.org/?literal=&amp;lt;&amp;nested=&amp;amp;&amp;number=&#38;lt;'
  const html = SEARCH_HTML
    .replace('http://www.sina.cn/news/detail/1.html', url)
    .replace('https://example.org/plain', url.replace('example.org', 'example.com'))
  const [first, second] = parseSo360Results(html)
  assert.equal(first.url, 'https://example.org/?literal=&lt;&nested=&amp;&number=&lt;')
  assert.equal(second.url, 'https://example.com/?literal=&lt;&nested=&amp;&number=&lt;')
})
