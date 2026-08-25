const SEARCH_ENDPOINT = 'https://www.bing.com/search'
const MAX_RESPONSE_BYTES = 1024 * 1024

export class BingWebSearchError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'BingWebSearchError'
    this.code = code
  }
}

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function decodeXml(value) {
  return String(value || '')
    .replace(/^<!\[CDATA\[|\]\]>$/gu, '')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&apos;/giu, "'")
    .replace(/&#(\d+);/gu, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/giu, (_, code) => (
      String.fromCodePoint(Number.parseInt(code, 16))
    ))
}

function xmlValue(block, tag) {
  return clean(decodeXml(
    new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'iu').exec(block)?.[1],
  ))
}

function publicUrl(value) {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      return ''
    }
    return url.toString()
  } catch {
    return ''
  }
}

export function parseBingRssResults(xml) {
  const results = []
  for (const match of String(xml || '').matchAll(/<item>([\s\S]*?)<\/item>/giu)) {
    const title = xmlValue(match[1], 'title')
    const url = publicUrl(xmlValue(match[1], 'link'))
    const snippet = xmlValue(match[1], 'description')
    if (!title || !url) continue
    results.push({
      title,
      url,
      ...(snippet ? { snippet } : {}),
      source: new URL(url).hostname,
    })
  }
  return results
}

async function boundedText(response) {
  const declaredLength = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new BingWebSearchError(
      'search_response_too_large',
      '简易搜索返回内容过大。',
    )
  }
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new BingWebSearchError(
      'search_response_too_large',
      '简易搜索返回内容过大。',
    )
  }
  return text
}

export class BingWebSearchProvider {
  constructor({ fetchImpl = fetch } = {}) {
    this.fetchImpl = fetchImpl
  }

  describe() {
    return {
      key: 'bing',
      label: 'Bing Web Search (fallback)',
    }
  }

  isConfigured() {
    return true
  }

  async search(query, { limit = 5, signal } = {}) {
    const normalizedQuery = clean(query).slice(0, 400)
    if (!normalizedQuery) {
      throw new BingWebSearchError(
        'missing_search_query',
        '搜索内容不能为空。',
      )
    }
    const boundedLimit = Math.max(1, Math.min(8, Math.trunc(Number(limit) || 5)))
    const url = new URL(SEARCH_ENDPOINT)
    url.searchParams.set('q', normalizedQuery)
    url.searchParams.set('format', 'rss')
    url.searchParams.set('mkt', 'zh-CN')
    let response
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          accept: 'application/rss+xml, application/xml, text/xml',
          'user-agent': 'qwen-audio-agent web-search',
        },
        redirect: 'error',
        signal,
      })
    } catch {
      throw new BingWebSearchError(
        signal?.aborted ? 'search_aborted' : 'search_request_failed',
        signal?.aborted ? '搜索已中止。' : '简易搜索服务暂时不可用。',
      )
    }
    const xml = await boundedText(response)
    if (!response.ok) {
      throw new BingWebSearchError(
        'search_request_failed',
        `简易搜索服务返回 HTTP ${response.status}。`,
      )
    }
    if (!/<rss\b/iu.test(xml)) {
      throw new BingWebSearchError(
        'search_response_invalid',
        '简易搜索没有返回预期的 RSS 内容。',
      )
    }
    const results = parseBingRssResults(xml).slice(0, boundedLimit)
    if (!results.length) {
      throw new BingWebSearchError(
        'search_results_missing',
        '简易搜索没有返回结果。',
      )
    }
    return { results }
  }
}
