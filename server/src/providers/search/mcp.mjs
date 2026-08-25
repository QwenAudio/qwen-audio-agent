import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { PACKAGE_VERSION } from '../../core/package-version.mjs'

const MAX_TOOL_TEXT_LENGTH = 24_000
const QUERY_FIELDS = ['query', 'q', 'search_query']
const LIMIT_FIELDS = ['limit', 'count', 'top_k', 'max_results']
const RESULT_KEYS = [
  'results',
  'search_results',
  'searchResults',
  'items',
  'pages',
]

export class McpWebSearchError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'McpWebSearchError'
    this.code = code
  }
}

function clean(value) {
  return String(value || '').trim()
}

function validateEndpoint(value, { hasToken = false } = {}) {
  let url
  try {
    url = new URL(clean(value))
  } catch {
    throw new McpWebSearchError(
      'invalid_search_endpoint',
      'Web Search MCP 地址无效。',
    )
  }
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
  if (
    url.username
    || url.password
    || url.hash
    || !['http:', 'https:'].includes(url.protocol)
    || (url.protocol !== 'https:' && (!loopback || hasToken))
  ) {
    throw new McpWebSearchError(
      'invalid_search_endpoint',
      '远程 Web Search MCP 必须使用 HTTPS；本地 HTTP 不能携带 Token。',
    )
  }
  return url
}

function textContent(result) {
  return (Array.isArray(result?.content) ? result.content : [])
    .filter(block => block?.type === 'text')
    .map(block => clean(block.text))
    .filter(Boolean)
    .join('\n')
    .slice(0, MAX_TOOL_TEXT_LENGTH)
}

function parseJsonText(text) {
  if (!text || !['{', '['].includes(text[0])) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function resultArray(value) {
  if (Array.isArray(value)) return value
  if (!value || typeof value !== 'object') return []
  for (const key of RESULT_KEYS) {
    if (Array.isArray(value[key])) return value[key]
  }
  for (const nested of [value.result, value.data, value.web]) {
    const results = resultArray(nested)
    if (results.length) return results
  }
  return []
}

function projectResult(item) {
  if (!item || typeof item !== 'object') return null
  const url = clean(item.url || item.link || item.href)
  if (!url) return null
  const snippet = clean(
    item.snippet || item.description || item.content || item.text,
  )
  const source = clean(
    item.source
    || item.site_name
    || item.siteName
    || item.hostname
    || item.domain,
  )
  const publishedAt = clean(
    item.publishedAt || item.published_at || item.published_date || item.date,
  )
  return {
    title: clean(item.title || item.name),
    url,
    ...(snippet ? { snippet } : {}),
    ...(source ? { source } : {}),
    ...(publishedAt ? { publishedAt } : {}),
  }
}

function linksFromText(text) {
  const results = []
  const seen = new Set()
  const add = (title, url) => {
    const normalized = clean(url).replace(/[.,;:!?]+$/, '')
    if (!normalized || seen.has(normalized)) return
    seen.add(normalized)
    results.push({ title: clean(title), url: normalized })
  }
  for (const match of text.matchAll(/\[([^\]]{1,300})\]\((https?:\/\/[^)\s]+)\)/giu)) {
    add(match[1], match[2])
  }
  for (const match of text.matchAll(/https?:\/\/[^\s<>()\]]+/giu)) {
    add('', match[0])
  }
  return results
}

function normalizeToolResult(result) {
  if (result?.isError) {
    throw new McpWebSearchError(
      'search_tool_failed',
      textContent(result) || 'Web Search MCP 工具调用失败。',
    )
  }
  const text = textContent(result)
  const structured = result?.structuredContent || parseJsonText(text)
  const results = resultArray(structured)
    .map(projectResult)
    .filter(Boolean)
  const projected = results.length ? results : linksFromText(text)
  if (!projected.length) {
    throw new McpWebSearchError(
      'search_sources_missing',
      'Web Search MCP 没有返回可核验来源。',
    )
  }
  return {
    ...(!structured && text ? { summary: text } : {}),
    results: projected,
  }
}

function callArguments(tool, query, limit) {
  const properties = tool?.inputSchema?.properties || {}
  const queryField = QUERY_FIELDS.find(field => field in properties) || 'query'
  const args = { [queryField]: query }
  const limitField = LIMIT_FIELDS.find(field => field in properties)
  if (limitField) args[limitField] = limit
  return args
}

function defaultClientFactory() {
  return new Client({ name: 'qwen-audio-agent', version: PACKAGE_VERSION })
}

function defaultTransportFactory(url, options) {
  return new StreamableHTTPClientTransport(url, options)
}

export class McpWebSearchProvider {
  constructor({
    url,
    token,
    toolName = 'web_search',
    key = 'mcp',
    label = 'MCP Web Search',
    requiresToken = false,
    clientFactory = defaultClientFactory,
    transportFactory = defaultTransportFactory,
  } = {}) {
    this.url = clean(url)
    this.token = clean(token)
    this.toolName = clean(toolName) || 'web_search'
    this.key = clean(key) || 'mcp'
    this.label = clean(label) || 'MCP Web Search'
    this.requiresToken = Boolean(requiresToken)
    this.clientFactory = clientFactory
    this.transportFactory = transportFactory
  }

  describe() {
    return {
      key: this.key,
      label: this.label,
      tool: this.toolName,
    }
  }

  isConfigured() {
    return Boolean(
      this.url
      && this.toolName
      && (!this.requiresToken || this.token),
    )
  }

  async search(query, { limit = 5, signal } = {}) {
    if (!this.isConfigured()) {
      throw new McpWebSearchError(
        'search_not_configured',
        'Web Search MCP 未配置。',
      )
    }
    const normalizedQuery = clean(query)
    if (!normalizedQuery) {
      throw new McpWebSearchError(
        'missing_search_query',
        '搜索内容不能为空。',
      )
    }
    const boundedLimit = Math.max(1, Math.min(8, Math.trunc(Number(limit) || 5)))
    const url = validateEndpoint(this.url, { hasToken: Boolean(this.token) })
    const client = this.clientFactory()
    const headers = this.token
      ? { authorization: `Bearer ${this.token}` }
      : undefined
    const transport = this.transportFactory(url, {
      ...(headers ? { requestInit: { headers } } : {}),
    })
    try {
      await client.connect(transport, { signal })
      const { tools = [] } = await client.listTools(undefined, { signal })
      const tool = tools.find(item => item.name === this.toolName)
      if (!tool) {
        throw new McpWebSearchError(
          'search_tool_missing',
          `Web Search MCP 未提供 ${this.toolName} 工具。`,
        )
      }
      const result = await client.callTool({
        name: this.toolName,
        arguments: callArguments(tool, normalizedQuery, boundedLimit),
      }, undefined, { signal })
      return normalizeToolResult(result)
    } catch (error) {
      if (error instanceof McpWebSearchError) throw error
      throw new McpWebSearchError(
        signal?.aborted ? 'search_aborted' : 'search_request_failed',
        signal?.aborted ? '搜索已中止。' : '暂时无法连接 Web Search MCP。',
      )
    } finally {
      await client.close().catch(() => {})
    }
  }
}
