const SEARCH_ENDPOINT = 'https://html.duckduckgo.com/html/'
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

export class DuckDuckGoWebSearchError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'DuckDuckGoWebSearchError'
    this.code = code
  }
}

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&#(?:39|x27);/giu, "'")
    .replace(/&nbsp;/giu, ' ')
    .replace(/&#(\d+);/gu, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/giu, (_, code) => (
      String.fromCodePoint(Number.parseInt(code, 16))
    ))
}

function plainText(value) {
  return clean(decodeEntities(String(value || '').replace(/<[^>]+>/gu, ' ')))
}

function hrefFromAttributes(attributes) {
  return /\bhref=(?:"([^"]*)"|'([^']*)')/iu.exec(attributes)?.slice(1)
    .find(Boolean) || ''
}

function resultUrl(value) {
  const raw = decodeEntities(value)
  try {
    const candidate = raw.startsWith('//') ? `https:${raw}` : raw
    const url = new URL(candidate, SEARCH_ENDPOINT)
    return url.searchParams.get('uddg') || url.toString()
  } catch {
    return raw
  }
}

export function parseDuckDuckGoResults(html) {
  const results = []
  const titlePattern = /<a\b(?=[^>]*\bclass=(?:"[^"]*\bresult__a\b[^"]*"|'[^']*\bresult__a\b[^']*'))([^>]*)>([\s\S]*?)<\/a>/giu
  const nextPattern = /<a\b(?=[^>]*\bclass=(?:"[^"]*\bresult__a\b[^"]*"|'[^']*\bresult__a\b[^']*'))/iu
  const snippetPattern = /<(?:a|div)\b(?=[^>]*\bclass=(?:"[^"]*\bresult__snippet\b[^"]*"|'[^']*\bresult__snippet\b[^']*'))[^>]*>([\s\S]*?)<\/(?:a|div)>/iu
  for (const match of html.matchAll(titlePattern)) {
    const title = plainText(match[2])
    const url = resultUrl(hrefFromAttributes(match[1]))
    const tail = html.slice((match.index || 0) + match[0].length)
    const nextIndex = tail.search(nextPattern)
    const resultBlock = nextIndex >= 0 ? tail.slice(0, nextIndex) : tail
    const snippet = plainText(snippetPattern.exec(resultBlock)?.[1])
    if (!title || !url) continue
    let source = ''
    try {
      source = new URL(url).hostname
    } catch {}
    results.push({
      title,
      url,
      ...(snippet ? { snippet } : {}),
      ...(source ? { source } : {}),
    })
  }
  return results
}

function isChallenge(html) {
  return !/\bresult__a\b/iu.test(html)
    && /captcha|challenge-form|are you a human/iu.test(html)
}

async function boundedText(response) {
  const declaredLength = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new DuckDuckGoWebSearchError(
      'search_response_too_large',
      '简易搜索返回内容过大。',
    )
  }
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new DuckDuckGoWebSearchError(
      'search_response_too_large',
      '简易搜索返回内容过大。',
    )
  }
  return text
}

export class DuckDuckGoWebSearchProvider {
  constructor({ fetchImpl = fetch } = {}) {
    this.fetchImpl = fetchImpl
  }

  describe() {
    return {
      key: 'duckduckgo',
      label: 'DuckDuckGo Web Search (fallback)',
    }
  }

  isConfigured() {
    return true
  }

  async search(query, { limit = 5, signal } = {}) {
    const normalizedQuery = clean(query).slice(0, 400)
    if (!normalizedQuery) {
      throw new DuckDuckGoWebSearchError(
        'missing_search_query',
        '搜索内容不能为空。',
      )
    }
    const boundedLimit = Math.max(1, Math.min(8, Math.trunc(Number(limit) || 5)))
    const url = new URL(SEARCH_ENDPOINT)
    url.searchParams.set('q', normalizedQuery)
    url.searchParams.set('kp', '-1')
    let response
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          accept: 'text/html',
          'user-agent': 'Mozilla/5.0 qwen-audio-agent web-search',
        },
        redirect: 'error',
        signal,
      })
    } catch {
      throw new DuckDuckGoWebSearchError(
        signal?.aborted ? 'search_aborted' : 'search_request_failed',
        signal?.aborted ? '搜索已中止。' : '简易搜索服务暂时不可用。',
      )
    }
    const html = await boundedText(response)
    if (!response.ok) {
      throw new DuckDuckGoWebSearchError(
        'search_request_failed',
        `简易搜索服务返回 HTTP ${response.status}。`,
      )
    }
    if (isChallenge(html)) {
      throw new DuckDuckGoWebSearchError(
        'search_challenge',
        '简易搜索服务要求进行人机验证。',
      )
    }
    const results = parseDuckDuckGoResults(html).slice(0, boundedLimit)
    if (!results.length) {
      throw new DuckDuckGoWebSearchError(
        'search_results_missing',
        '简易搜索没有返回结果。',
      )
    }
    return { results }
  }
}
