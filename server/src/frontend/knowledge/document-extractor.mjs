import { extname } from 'node:path'

const EXTRACTOR_KEY = /^[a-z0-9][a-z0-9-]*$/u
const TEXT_MIME_TYPES = new Set([
  'application/json',
  'application/x-ndjson',
  'text/csv',
  'text/html',
  'text/markdown',
  'text/plain',
])
const EXTENSION_MIME_TYPES = new Map([
  ['.csv', 'text/csv'],
  ['.htm', 'text/html'],
  ['.html', 'text/html'],
  ['.json', 'application/json'],
  ['.jsonl', 'application/x-ndjson'],
  ['.md', 'text/markdown'],
  ['.markdown', 'text/markdown'],
  ['.txt', 'text/plain'],
])

function extractorError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function normalizeMimeType(value, filename = '') {
  const configured = String(value || '').split(';', 1)[0].trim().toLowerCase()
  if (configured) return configured
  return EXTENSION_MIME_TYPES.get(extname(String(filename)).toLowerCase()) || ''
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&(?:apos|#39);/giu, "'")
    .replace(/&#(\d+);/gu, (match, code) => {
      const value = Number(code)
      return Number.isInteger(value)
        && value >= 0
        && value <= 0x10ffff
        && !(value >= 0xd800 && value <= 0xdfff)
        ? String.fromCodePoint(value)
        : match
    })
}

function htmlText(value) {
  return decodeEntities(String(value || '')
    .replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/giu, ' ')
    .replace(/<!--([\s\S]*?)-->/gu, ' ')
    .replace(/<\/?(?:p|div|section|article|header|footer|main|aside|nav|h[1-6]|li|tr|br|hr)\b[^>]*>/giu, '\n')
    .replace(/<[^>]+>/gu, ' '))
}

function normalizedText(value) {
  return String(value || '')
    .replaceAll('\0', '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function sourceBytes(content) {
  if (typeof content === 'string') return Buffer.from(content)
  if (content instanceof Uint8Array) {
    return Buffer.from(content.buffer, content.byteOffset, content.byteLength)
  }
  throw extractorError(
    'invalid_document_content',
    'Document content must be UTF-8 text or bytes.',
  )
}

export function assertDocumentExtractor(value, { name = 'DocumentExtractor' } = {}) {
  if (!value || typeof value !== 'object') {
    throw new TypeError(`${name} must be an object`)
  }
  const missing = ['describe', 'supports', 'extract']
    .filter(method => typeof value[method] !== 'function')
  if (missing.length) {
    throw new TypeError(`${name} is missing required methods: ${missing.join(', ')}`)
  }
  const description = value.describe()
  if (
    !description
    || !EXTRACTOR_KEY.test(String(description.key || ''))
    || !String(description.label || '').trim()
  ) {
    throw new TypeError(`${name} describe() returned an invalid identity`)
  }
  return value
}

export class TextDocumentExtractor {
  constructor({
    maxSourceBytes = 5 * 1024 * 1024,
    maxTextChars = 500_000,
  } = {}) {
    this.maxSourceBytes = maxSourceBytes
    this.maxTextChars = maxTextChars
  }

  describe() {
    return {
      key: 'builtin-text',
      label: 'Built-in Text Document Extractor',
      mimeTypes: [...TEXT_MIME_TYPES],
    }
  }

  supports(mimeType, { filename = '' } = {}) {
    return TEXT_MIME_TYPES.has(normalizeMimeType(mimeType, filename))
  }

  async extract(source, { signal } = {}) {
    if (signal?.aborted) throw extractorError('document_extraction_aborted', 'Document extraction was aborted.')
    const filename = String(source?.filename || source?.title || '').trim()
    const mimeType = normalizeMimeType(source?.mimeType, filename)
    if (!this.supports(mimeType, { filename })) {
      throw extractorError(
        'unsupported_document_type',
        `Unsupported document type: ${mimeType || 'unknown'}`,
      )
    }
    const bytes = sourceBytes(source?.content)
    if (bytes.byteLength > this.maxSourceBytes) {
      throw extractorError('document_too_large', 'Document exceeds the extraction size limit.')
    }
    let decoded
    try {
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      throw extractorError('invalid_document_encoding', 'Document is not valid UTF-8 text.')
    }
    const text = normalizedText(mimeType === 'text/html' ? htmlText(decoded) : decoded)
    if (!text) throw extractorError('document_text_missing', 'Document contains no extractable text.')
    if ([...text].length > this.maxTextChars) {
      throw extractorError('document_text_too_large', 'Extracted document text exceeds the limit.')
    }
    return {
      title: filename || 'Document',
      mimeType,
      text,
    }
  }
}
