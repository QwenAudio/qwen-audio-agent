const SEARCH_ENDPOINT = 'https://www.bing.com/search'
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

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

function decodedCodePoint(value, radix) {
  const codePoint = Number.parseInt(value, radix)
  if (
    !Number.isInteger(codePoint)
    || codePoint < 0
    || codePoint > 0x10ffff
    || (codePoint >= 0xd800 && codePoint <= 0xdfff)
  ) return '\ufffd'
  return String.fromCodePoint(codePoint)
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&(?:apos|#(?:39|x27));/giu, "'")
    .replace(/&nbsp;/giu, ' ')
    .replace(/&ensp;/giu, ' ')
    .replace(/&emsp;/giu, ' ')
    .replace(/&middot;/giu, '·')
    .replace(/&#(\d+);/gu, (_, code) => decodedCodePoint(code, 10))
    .replace(/&#x([0-9a-f]+);/giu, (_, code) => decodedCodePoint(code, 16))
}

function plainText(value) {
  return clean(decodeEntities(
    String(value || '')
      .replace(/^<!\[CDATA\[|\]\]>$/gu, '')
      // Bing wraps query terms in <strong> inside words; drop them without
      // spacing so highlighted words stay intact.
      .replace(/<\/?strong\b[^>]*>/giu, '')
      .replace(/<[^>]+>/gu, ' '),
  ))
}

function publicUrl(value) {
  try {
    const url = new URL(decodeEntities(value))
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      return ''
    }
    return url.toString()
  } catch {
    return ''
  }
}

export function parseBingHtmlResults(html) {
  const results = []
  const seen = new Set()
  for (const match of String(html || '').matchAll(/<li\b[^>]*\bb_algo\b[\s\S]*?<\/li>/giu)) {
    const block = match[0]
    const titleMatch = /<h2\b[^>]*>[\s\S]*?<a\b[^>]*href=(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/iu.exec(block)
    if (!titleMatch) continue
    const title = plainText(titleMatch[3])
    const url = publicUrl(titleMatch[1] || titleMatch[2])
    if (!title || !url || seen.has(url)) continue
    seen.add(url)
    const captionMatch = /\bb_caption\b[\s\S]*?<p\b[^>]*>([\s\S]*?)<\/p>/iu.exec(block)
    const snippet = captionMatch ? plainText(captionMatch[1]) : ''
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

  async #fetchPage(url, accept, signal) {
    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          accept,
          'user-agent': 'qwen-audio-agent web-search',
        },
        redirect: 'error',
        signal,
      })
      const body = await boundedText(response)
      if (!response.ok) {
        throw new BingWebSearchError(
          'search_request_failed',
          `简易搜索服务返回 HTTP ${response.status}。`,
        )
      }
      return body
    } catch (error) {
      if (error instanceof BingWebSearchError) throw error
      throw new BingWebSearchError(
        signal?.aborted ? 'search_aborted' : 'search_request_failed',
        signal?.aborted ? '搜索已中止。' : '简易搜索服务暂时不可用。',
      )
    }
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
    const htmlUrl = new URL(SEARCH_ENDPOINT)
    htmlUrl.searchParams.set('q', normalizedQuery)
    htmlUrl.searchParams.set('mkt', 'zh-CN')
    const html = await this.#fetchPage(htmlUrl, 'text/html', signal)
    const results = parseBingHtmlResults(html).slice(0, boundedLimit)
    if (!results.length) {
      throw new BingWebSearchError(
        'search_results_missing',
        '简易搜索没有返回结果。',
      )
    }
    return { results }
  }
}
