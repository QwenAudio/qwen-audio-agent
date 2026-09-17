const SEARCH_ENDPOINT = 'https://www.so.com/s'
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

export class So360WebSearchError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'So360WebSearchError'
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
      // 360 wraps query terms in <em> inside words; drop them without
      // spacing so highlighted words stay intact.
      .replace(/<\/?em\b[^>]*>/giu, '')
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

function attributeValue(tag, name) {
  const match = new RegExp(`\\b${name}=(?:"([^"]*)"|'([^']*)')`, 'iu').exec(tag)
  return match ? (match[1] ?? match[2]) : ''
}

export function parseSo360Results(html) {
  const results = []
  const seen = new Set()
  for (const match of String(html || '').matchAll(/<li\b[^>]*\bres-list\b[\s\S]*?<\/li>/giu)) {
    const block = match[0]
    const titleMatch = /<h3\b[^>]*\bres-title\b[\s\S]*?<a\b[^>]*>([\s\S]*?)<\/a>/iu.exec(block)
    if (!titleMatch) continue
    const anchorTag = /<a\b[^>]*>/iu.exec(titleMatch[0])?.[0] || ''
    const title = plainText(titleMatch[1])
    // data-mdurl carries the real destination; href is an so.com redirect.
    const url = publicUrl(
      attributeValue(anchorTag, 'data-mdurl') || attributeValue(anchorTag, 'href'),
    )
    if (!title || !url || seen.has(url)) continue
    seen.add(url)
    const descMatch = /<p\b[^>]*\bres-desc\b[^>]*>([\s\S]*?)<\/p>/iu.exec(block)
    const snippet = descMatch ? plainText(descMatch[1]) : ''
    results.push({
      title,
      url,
      ...(snippet ? { snippet } : {}),
      source: new URL(url).hostname,
    })
  }
  return results
}

function isChallenge(html) {
  return !/\bres-title\b/iu.test(html)
    && /captcha|antispider|人机验证/iu.test(html)
}

async function boundedText(response) {
  const declaredLength = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new So360WebSearchError(
      'search_response_too_large',
      '简易搜索返回内容过大。',
    )
  }
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new So360WebSearchError(
      'search_response_too_large',
      '简易搜索返回内容过大。',
    )
  }
  return text
}

export class So360WebSearchProvider {
  constructor({ fetchImpl = fetch } = {}) {
    this.fetchImpl = fetchImpl
  }

  describe() {
    return {
      key: 'so360',
      label: '360 Web Search (fallback)',
    }
  }

  isConfigured() {
    return true
  }

  async #fetchPage(url, signal) {
    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          accept: 'text/html',
          'user-agent': 'qwen-audio-agent web-search',
        },
        redirect: 'error',
        signal,
      })
      const html = await boundedText(response)
      if (!response.ok) {
        throw new So360WebSearchError(
          'search_request_failed',
          `简易搜索服务返回 HTTP ${response.status}。`,
        )
      }
      return html
    } catch (error) {
      if (error instanceof So360WebSearchError) throw error
      throw new So360WebSearchError(
        signal?.aborted ? 'search_aborted' : 'search_request_failed',
        signal?.aborted ? '搜索已中止。' : '简易搜索服务暂时不可用。',
      )
    }
  }

  async search(query, { limit = 5, signal } = {}) {
    const normalizedQuery = clean(query).slice(0, 400)
    if (!normalizedQuery) {
      throw new So360WebSearchError(
        'missing_search_query',
        '搜索内容不能为空。',
      )
    }
    const boundedLimit = Math.max(1, Math.min(8, Math.trunc(Number(limit) || 5)))
    const url = new URL(SEARCH_ENDPOINT)
    url.searchParams.set('q', normalizedQuery)
    const html = await this.#fetchPage(url, signal)
    if (isChallenge(html)) {
      throw new So360WebSearchError(
        'search_challenge',
        '简易搜索服务要求进行人机验证。',
      )
    }
    const results = parseSo360Results(html).slice(0, boundedLimit)
    if (!results.length) {
      throw new So360WebSearchError(
        'search_results_missing',
        '简易搜索没有返回结果。',
      )
    }
    return { results }
  }
}
