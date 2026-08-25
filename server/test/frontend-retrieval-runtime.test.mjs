import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import {
  FrontendRetrievalRuntime,
} from '../src/frontend/retrieval/frontend-retrieval-runtime.mjs'
import {
  SafeUrlFetcher,
} from '../src/frontend/retrieval/safe-url-fetcher.mjs'
import {
  validateWebSearchProvider,
} from '../src/frontend/retrieval/web-search-provider.mjs'

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address()))
  })
}

function close(server) {
  return new Promise(resolve => server.close(resolve))
}

test('normalizes provider search results into bounded citations', async () => {
  const searches = []
  const provider = {
    describe: () => ({ key: 'example-search', label: 'Example Search' }),
    isConfigured: () => true,
    search: async (query, options) => {
      searches.push({ query, options })
      return {
        results: [
          {
            title: ' Example result ',
            url: 'https://example.com/page#section',
            snippet: ' useful   facts ',
          },
          {
            title: 'Duplicate',
            url: 'https://example.com/page',
          },
          { title: 'Unsafe', url: 'file:///etc/passwd' },
        ],
      }
    },
  }
  const runtime = new FrontendRetrievalRuntime({
    searchProvider: provider,
    urlFetcher: null,
  })

  assert.deepEqual(runtime.capabilities(), ['web-search'])
  const result = await runtime.search('latest example', { limit: 8 })

  assert.equal(searches[0].query, 'latest example')
  assert.equal(searches[0].options.limit, 8)
  assert.deepEqual(result.results, [{
    title: 'Example result',
    url: 'https://example.com/page',
    snippet: 'useful facts',
    citation_id: 'source_1',
  }])
  assert.equal(result.citations[0].id, 'source_1')
})

test('rejects incomplete search providers at the composition boundary', () => {
  assert.throws(
    () => validateWebSearchProvider({
      describe: () => ({ key: 'incomplete', label: 'Incomplete' }),
    }),
    /isConfigured/,
  )
})

test('safe URL fetch blocks loopback by default', async () => {
  const fetcher = new SafeUrlFetcher()
  for (const url of [
    'http://127.0.0.1/private',
    'http://2130706433/private',
    'http://[::1]/private',
  ]) {
    await assert.rejects(
      fetcher.fetch(url),
      error => error.code === 'private_network_forbidden',
    )
  }
  await assert.rejects(
    fetcher.fetch('file:///etc/passwd'),
    error => error.code === 'unsupported_protocol',
  )
  await assert.rejects(
    fetcher.fetch('https://user:password@example.com/'),
    error => error.code === 'url_credentials_forbidden',
  )
})

test('fetches bounded public-page text and returns a citation', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/page' })
      response.end()
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html>
      <title>Example &amp; page</title>
      <script>ignoreThis()</script>
      <main><h1>Useful heading</h1><p>Useful body.</p></main>`)
  })
  const address = await listen(server)
  try {
    const runtime = new FrontendRetrievalRuntime({
      urlFetcher: new SafeUrlFetcher({ allowPrivateNetwork: true }),
    })
    assert.deepEqual(runtime.capabilities(), ['url-fetch'])
    const result = await runtime.fetchUrl(
      `http://127.0.0.1:${address.port}/redirect`,
    )
    assert.equal(result.title, 'Example & page')
    assert.match(result.content, /Useful heading/)
    assert.match(result.content, /Useful body/)
    assert.doesNotMatch(result.content, /ignoreThis/)
    assert.equal(result.citations[0].url, result.url)
    assert.match(result.notice, /不可信资料/)
  } finally {
    await close(server)
  }
})
