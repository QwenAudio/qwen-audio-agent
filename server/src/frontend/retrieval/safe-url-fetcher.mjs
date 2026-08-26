import { lookup as dnsLookup } from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { BlockList, isIP, SocketAddress } from 'node:net'

const blockedIpv4Addresses = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) blockedIpv4Addresses.addSubnet(network, prefix, 'ipv4')
const blockedIpv6Addresses = new BlockList()
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
]) blockedIpv6Addresses.addSubnet(network, prefix, 'ipv6')

const SUPPORTED_CONTENT_TYPES = [
  'text/html',
  'text/plain',
  'application/json',
  'application/xml',
  'application/xhtml+xml',
  'text/xml',
]

export class UrlFetchError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'UrlFetchError'
    this.code = code
  }
}

function publicUrl(value) {
  let url
  try {
    url = new URL(String(value || '').trim())
  } catch {
    throw new UrlFetchError('invalid_url', '网址格式无效。')
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new UrlFetchError('unsupported_protocol', '只支持 HTTP 或 HTTPS 网址。')
  }
  if (url.username || url.password) {
    throw new UrlFetchError('url_credentials_forbidden', '网址不能包含登录凭据。')
  }
  url.hash = ''
  return url
}

function normalizedNetworkAddress(address, family) {
  const type = family === 6 || family === 'IPv6' ? 'ipv6' : 'ipv4'
  if (type !== 'ipv6') return { address, type }

  const parsed = SocketAddress.parse(`[${address}]:0`)
  const normalized = parsed?.address || String(address || '')
  const mappedPrefix = '::ffff:'
  if (normalized.toLowerCase().startsWith(mappedPrefix)) {
    const mappedAddress = normalized.slice(mappedPrefix.length)
    if (isIP(mappedAddress) === 4) {
      return { address: mappedAddress, type: 'ipv4' }
    }
  }
  return { address: normalized, type }
}

export function isBlockedAddress(address, family) {
  const normalized = normalizedNetworkAddress(address, family)
  return normalized.type === 'ipv6'
    ? blockedIpv6Addresses.check(normalized.address, 'ipv6')
    : blockedIpv4Addresses.check(normalized.address, 'ipv4')
}

export function createPinnedLookup({ address, family }) {
  return (_hostname, options, callback) => {
    if (options?.all) {
      callback(null, [{ address, family }])
      return
    }
    callback(null, address, family)
  }
}

async function resolvePublicAddress(hostname, { allowPrivateNetwork = false } = {}) {
  const normalizedHostname = String(hostname).replace(/^\[(.*)]$/, '$1')
  const literalFamily = isIP(normalizedHostname)
  const addresses = literalFamily
    ? [{ address: normalizedHostname, family: literalFamily }]
    : await dnsLookup(normalizedHostname, { all: true, verbatim: true })
  if (!addresses.length) {
    throw new UrlFetchError('host_not_found', '无法解析网址主机。')
  }
  if (
    !allowPrivateNetwork
    && addresses.some(({ address, family }) => isBlockedAddress(address, family))
  ) {
    throw new UrlFetchError('private_network_forbidden', '不能访问本机或内网网址。')
  }
  return addresses[0]
}

function requestOnce(url, address, {
  signal,
  timeoutMs,
  maxBytes,
  userAgent,
}) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http
    const request = transport.request(url, {
      method: 'GET',
      headers: {
        accept: 'text/html,text/plain,application/json,application/xml;q=0.8,*/*;q=0.1',
        'accept-encoding': 'identity',
        'user-agent': userAgent,
      },
      lookup: createPinnedLookup(address),
    }, response => {
      const chunks = []
      let size = 0
      response.on('data', chunk => {
        size += chunk.length
        if (size > maxBytes) {
          request.destroy(new UrlFetchError(
            'response_too_large',
            '网页内容超过前台工具的读取上限。',
          ))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => resolve({
        statusCode: response.statusCode || 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
      response.on('aborted', () => reject(new UrlFetchError(
        'response_aborted',
        '网页连接在读取完成前中断。',
      )))
      response.on('error', reject)
    })
    const timeout = setTimeout(() => request.destroy(
      new UrlFetchError('fetch_timeout', '读取网页超时。'),
    ), timeoutMs)
    const abort = () => request.destroy(
      new UrlFetchError('fetch_aborted', '网页读取已中止。'),
    )
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    request.on('close', () => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
    })
    request.on('error', reject)
    request.end()
  })
}

function decodeEntities(value) {
  const named = {
    amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"',
  }
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] !== '#') return named[entity.toLowerCase()] ?? match
    const radix = entity[1]?.toLowerCase() === 'x' ? 16 : 10
    const digits = radix === 16 ? entity.slice(2) : entity.slice(1)
    const codePoint = Number.parseInt(digits, radix)
    try {
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match
    } catch {
      return match
    }
  })
}

function htmlTitle(html) {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)
  return decodeEntities(String(match?.[1] || '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)
}

function htmlToText(html) {
  return decodeEntities(html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(?:script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript|svg)>/gi, ' ')
    .replace(/<(?:br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(?:p|div|section|article|header|footer|main|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]*>/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export class SafeUrlFetcher {
  constructor({
    timeoutMs = 8_000,
    maxBytes = 1024 * 1024,
    maxChars = 40_000,
    maxRedirects = 3,
    allowPrivateNetwork = false,
    userAgent = 'qwen-audio-agent/1.0 (+https://github.com/QwenAudio/qwen-audio-agent)',
  } = {}) {
    this.timeoutMs = timeoutMs
    this.maxBytes = maxBytes
    this.maxChars = maxChars
    this.maxRedirects = maxRedirects
    this.allowPrivateNetwork = allowPrivateNetwork
    this.userAgent = userAgent
  }

  async fetch(input, { signal } = {}) {
    let url = publicUrl(input)
    for (let redirects = 0; redirects <= this.maxRedirects; redirects += 1) {
      const address = await resolvePublicAddress(url.hostname, {
        allowPrivateNetwork: this.allowPrivateNetwork,
      })
      const response = await requestOnce(url, address, {
        signal,
        timeoutMs: this.timeoutMs,
        maxBytes: this.maxBytes,
        userAgent: this.userAgent,
      })
      if (
        response.statusCode >= 300
        && response.statusCode < 400
        && response.headers.location
      ) {
        if (redirects === this.maxRedirects) {
          throw new UrlFetchError('too_many_redirects', '网页重定向次数过多。')
        }
        url = publicUrl(new URL(response.headers.location, url).toString())
        continue
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new UrlFetchError(
          'http_error',
          `网页返回 HTTP ${response.statusCode}。`,
        )
      }
      const contentType = String(response.headers['content-type'] || 'text/plain')
        .split(';')[0]
        .trim()
        .toLowerCase()
      if (!SUPPORTED_CONTENT_TYPES.includes(contentType)) {
        throw new UrlFetchError(
          'unsupported_content_type',
          `暂不支持读取 ${contentType || '未知'} 类型的网页内容。`,
        )
      }
      const isHtml = ['text/html', 'application/xhtml+xml'].includes(contentType)
      const content = (isHtml ? htmlToText(response.body) : response.body.trim())
        .slice(0, this.maxChars)
      return {
        status: 'ok',
        url: url.toString(),
        title: isHtml ? htmlTitle(response.body) || url.hostname : url.hostname,
        media_type: contentType,
        content,
      }
    }
    throw new UrlFetchError('too_many_redirects', '网页重定向次数过多。')
  }
}
