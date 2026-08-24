export const MAX_INPUT_PARTS = 16
export const MAX_INPUT_FILE_BYTES = 8 * 1024 * 1024
export const MAX_INPUT_TOTAL_FILE_BYTES = 12 * 1024 * 1024
export const INPUT_REF_META_KEY = 'qwen-audio-agent/inputRef'

// Local paths are resolved and inlined by trusted clients (such as the TUI).
// Never let a remote client turn the Gateway into an arbitrary local-file
// reference bridge by submitting file: URLs directly.
const ALLOWED_URL_PROTOCOLS = new Set(['data:', 'http:', 'https:'])

function cleanText(value, max = 100_000) {
  return String(value || '').replaceAll('\u0000', '').slice(0, max)
}

function cleanFilename(value) {
  return cleanText(value, 240).replace(/[\r\n\t]/g, ' ').trim()
}

function decodedBase64Bytes(value) {
  const content = String(value || '').replace(/\s/g, '')
  if (!content) return 0
  const padding = content.endsWith('==') ? 2 : content.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor(content.length * 3 / 4) - padding)
}

export function parseDataUrl(value) {
  const url = String(value || '')
  const match = /^data:([^;,]+)(?:;charset=([^;,]+))?;base64,([a-z\d+/=\s]+)$/i.exec(url)
  if (!match) return null
  return {
    mimeType: match[1].toLowerCase(),
    charset: match[2] || '',
    data: match[3].replace(/\s/g, ''),
    bytes: decodedBase64Bytes(match[3]),
  }
}

function normalizeSource(source) {
  if (!source || typeof source !== 'object') return undefined
  const type = ['clipboard', 'file', 'resource'].includes(source.type)
    ? source.type
    : 'file'
  const text = source.text && typeof source.text === 'object'
    ? {
        value: cleanText(source.text.value, 2048),
        ...(Number.isInteger(source.text.start) ? { start: source.text.start } : {}),
        ...(Number.isInteger(source.text.end) ? { end: source.text.end } : {}),
      }
    : null
  const path = cleanText(source.path, 2048).trim()
  return {
    type,
    ...(path ? { path } : {}),
    ...(text?.value ? { text } : {}),
  }
}

function normalizeFilePart(part) {
  const mime = cleanText(part.mime || part.mimeType, 160).trim().toLowerCase()
  if (!mime || !mime.includes('/')) throw new Error('附件缺少有效的 MIME 类型')
  const url = cleanText(part.url, 20 * 1024 * 1024).trim()
  if (!url) throw new Error('附件缺少内容 URL')
  let protocol
  try {
    protocol = new URL(url).protocol
  } catch {
    throw new Error('附件 URL 无效')
  }
  if (!ALLOWED_URL_PROTOCOLS.has(protocol)) {
    throw new Error(`不支持的附件 URL 协议：${protocol}`)
  }
  const dataUrl = protocol === 'data:' ? parseDataUrl(url) : null
  if (protocol === 'data:' && !dataUrl) {
    throw new Error('附件 data URL 必须使用 base64 编码')
  }
  if (dataUrl && dataUrl.mimeType !== mime) {
    throw new Error(`附件 MIME 不一致：${mime} / ${dataUrl.mimeType}`)
  }
  if (dataUrl?.bytes > MAX_INPUT_FILE_BYTES) {
    throw new Error(`附件超过 ${MAX_INPUT_FILE_BYTES / 1024 / 1024} MB 限制`)
  }
  const source = normalizeSource(part.source)
  return {
    type: 'file',
    mime,
    ...(cleanFilename(part.filename) ? { filename: cleanFilename(part.filename) } : {}),
    url,
    ...(source ? { source } : {}),
  }
}

export function normalizeInputParts(parts, { fallbackText = '' } = {}) {
  const source = Array.isArray(parts) ? parts : []
  if (source.length > MAX_INPUT_PARTS) {
    throw new Error(`一次最多提交 ${MAX_INPUT_PARTS} 个输入片段`)
  }
  const normalized = source.flatMap(part => {
    if (!part || typeof part !== 'object') return []
    if (part.type === 'text') {
      const text = cleanText(part.text).trim()
      return text ? [{ type: 'text', text }] : []
    }
    if (part.type === 'file') return [normalizeFilePart(part)]
    throw new Error(`不支持的输入片段类型：${String(part.type || '')}`)
  })
  if (!normalized.some(part => part.type === 'text')) {
    const text = cleanText(fallbackText).trim()
    if (text) normalized.unshift({ type: 'text', text })
  }
  const totalBytes = normalized.reduce((sum, part) => (
    part.type === 'file' ? sum + (parseDataUrl(part.url)?.bytes || 0) : sum
  ), 0)
  if (totalBytes > MAX_INPUT_TOTAL_FILE_BYTES) {
    throw new Error(`本轮附件总大小超过 ${MAX_INPUT_TOTAL_FILE_BYTES / 1024 / 1024} MB 限制`)
  }
  if (!normalized.length) throw new Error('输入内容不能为空')
  return normalized
}

export function inputText(parts = []) {
  return parts
    .filter(part => part?.type === 'text')
    .map(part => String(part.text || '').trim())
    .filter(Boolean)
    .join('\n')
}

export function inputFileParts(parts = []) {
  return parts.filter(part => part?.type === 'file')
}

export function inputPartRef(part) {
  return String(part?._meta?.[INPUT_REF_META_KEY] || '').trim()
}

export function withInputPartRef(part, ref) {
  const value = String(ref || '').trim()
  if (!value) return part
  return {
    ...part,
    _meta: {
      ...(part?._meta || {}),
      [INPUT_REF_META_KEY]: value,
    },
  }
}

export function inputPartReference(part, index = 0) {
  const supplied = String(part?.source?.text?.value || '').trim()
  if (supplied) return supplied.slice(0, 2048)
  if (String(part?.mime || '').startsWith('image/')) return `[Image ${index + 1}]`
  return part?.filename ? `@${part.filename}` : `[File ${index + 1}]`
}

export function createInputFilePart({
  mime,
  filename,
  url,
  sourceType = 'file',
  path = '',
  reference = '',
} = {}, index = 0) {
  const part = {
    type: 'file',
    mime: String(mime || 'application/octet-stream'),
    ...(filename ? { filename: String(filename) } : {}),
    url: String(url || ''),
  }
  const value = String(reference || inputPartReference(part, index))
  return {
    ...part,
    source: {
      type: sourceType,
      ...(path ? { path: String(path) } : {}),
      text: { value },
    },
  }
}

export function inputPartLabel(part, index = 0) {
  return inputPartReference(part, index).slice(0, 120)
}

function uniqueAttachmentReferences(files) {
  const used = new Set()
  return files.map((part, index) => {
    let reference = inputPartReference(part, index)
    if (!used.has(reference)) {
      used.add(reference)
      return reference
    }
    const prefix = String(part?.mime || '').startsWith('image/')
      ? 'Image'
      : 'File'
    let ordinal = index + 1
    do {
      reference = `[${prefix} ${ordinal}]`
      ordinal += 1
    } while (used.has(reference))
    used.add(reference)
    return reference
  })
}

/**
 * Ensure every attachment has a textual reference anchor and bind that anchor
 * back to the file part with OpenCode-compatible source.text offsets.
 *
 * The file part remains authoritative. The text anchor preserves the user's
 * visible prompt and makes multi-attachment references replayable.
 */
export function withAttachmentAnchors(parts = []) {
  const files = inputFileParts(parts)
  if (!files.length) return parts
  const references = uniqueAttachmentReferences(files)
  const originalText = inputText(parts)
  const missing = references.filter(reference => !originalText.includes(reference))
  const text = [missing.join(' '), originalText].filter(Boolean).join(' ')
  let searchFrom = 0
  const anchoredFiles = files.map((part, index) => {
    const reference = references[index]
    let start = text.indexOf(reference, searchFrom)
    if (start < 0) start = text.indexOf(reference)
    searchFrom = start + reference.length
    return {
      ...part,
      source: {
        ...(part.source || {}),
        type: part.source?.type || 'file',
        text: {
          value: reference,
          start,
          end: start + reference.length,
        },
      },
    }
  })
  return [{ type: 'text', text }, ...anchoredFiles]
}

export function frontendInputProjection(parts = [], { accompaniesVoice = false } = {}) {
  const text = inputText(parts)
  const files = inputFileParts(parts)
  if (!files.length) return text
  const attachments = files.map((part, index) => ({
    ...(inputPartRef(part) ? { id: inputPartRef(part) } : {}),
    type: 'file',
    ...(part.filename ? { filename: part.filename } : {}),
    mime: part.mime,
    source: {
      type: part.source?.type || 'resource',
      text: { value: inputPartLabel(part, index) },
    },
  }))
  const metadata = JSON.stringify(attachments)
    .replaceAll('&', '\\u0026')
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
  return [
    text || (accompaniesVoice
      ? '本轮语音输入同时包含以下附件。'
      : '用户提交了附件，但没有附带文字说明。请自然询问希望如何处理；不要声称没有收到附件。'),
    '',
    '<input_parts>',
    metadata,
    '</input_parts>',
  ].join('\n')
}

export function displayInputText(parts = []) {
  const text = inputText(parts)
  if (text) return text
  const files = inputFileParts(parts)
  return files.map(inputPartLabel).join(' ')
}

export function inputAttachmentMetadata(parts = []) {
  return inputFileParts(parts).map((part, index) => ({
    label: inputPartLabel(part, index),
    name: part.filename || null,
    mime_type: part.mime,
    bytes: parseDataUrl(part.url)?.bytes || null,
  }))
}
