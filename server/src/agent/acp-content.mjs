import {
  inputFileParts,
  parseDataUrl,
} from '../../../shared/input-parts.mjs'

function clean(value) {
  return String(value || '').trim()
}

function filenameFromUri(uri, fallback) {
  const value = clean(uri)
  if (!value) return fallback
  try {
    const pathname = new URL(value).pathname
    const name = pathname.split('/').filter(Boolean).at(-1)
    return name ? decodeURIComponent(name) : fallback
  } catch {
    const name = value.split('/').filter(Boolean).at(-1)
    return name || fallback
  }
}

function artifactPartFromAcpBlock(block, index) {
  const fallbackName = `agent-output-${index + 1}`
  if (block?.type === 'image' || block?.type === 'audio') {
    const raw = clean(block.data)
    if (!raw) return null
    return {
      raw,
      mediaType: clean(block.mimeType) || (
        block.type === 'image' ? 'image/png' : 'audio/mpeg'
      ),
      filename: filenameFromUri(block.uri, fallbackName),
    }
  }
  if (block?.type === 'resource') {
    const resource = block.resource
    if (!resource || typeof resource !== 'object') return null
    const filename = filenameFromUri(
      resource.uri,
      clean(resource.name) || fallbackName,
    )
    if (typeof resource.text === 'string') {
      return {
        text: resource.text,
        mediaType: clean(resource.mimeType) || 'text/plain',
        filename,
      }
    }
    if (typeof resource.blob === 'string') {
      return {
        raw: resource.blob,
        mediaType: clean(resource.mimeType) || 'application/octet-stream',
        filename,
      }
    }
    return null
  }
  if (block?.type === 'resource_link') {
    const uri = clean(block.uri)
    if (!uri) return null
    const filename = clean(block.name)
      || filenameFromUri(uri, fallbackName)
    if (/^(?:data|https?):/i.test(uri)) {
      return {
        url: uri,
        mediaType: clean(block.mimeType) || 'application/octet-stream',
        filename,
      }
    }
    return {
      data: {
        type: 'resource_link',
        uri,
        ...(block.description ? { description: clean(block.description) } : {}),
      },
      mediaType: 'application/vnd.qwen-audio-agent.resource-link+json',
      filename,
    }
  }
  return null
}

export function artifactsFromAcpContentBlocks(blocks = [], { startIndex = 0 } = {}) {
  const artifacts = []
  for (const block of Array.isArray(blocks) ? blocks : []) {
    const outputIndex = startIndex + artifacts.length
    const part = artifactPartFromAcpBlock(block, outputIndex)
    if (!part) continue
    artifacts.push({
      artifactId: `acp_content_${outputIndex + 1}`,
      name: part.filename || `Agent output ${outputIndex + 1}`,
      parts: [part],
    })
  }
  return artifacts
}

function resourceUri(part, index) {
  const filename = String(part.filename || `attachment-${index + 1}`)
  return `qwen-audio-agent://input/${encodeURIComponent(filename)}`
}

function isTextMime(mime) {
  return mime.startsWith('text/') || [
    'application/json',
    'application/javascript',
    'application/xml',
    'application/yaml',
    'application/x-yaml',
  ].includes(mime)
}

function decodeUtf8(data) {
  return Buffer.from(data, 'base64').toString('utf8')
}

export function inputPartsToAcpBlocks(parts = []) {
  return inputFileParts(parts).map((part, index) => {
    const embedded = parseDataUrl(part.url)
    if (!embedded) {
      return {
        type: 'resource_link',
        uri: part.url,
        name: part.filename || `attachment-${index + 1}`,
        mimeType: part.mime,
      }
    }
    if (part.mime.startsWith('image/')) {
      return {
        type: 'image',
        mimeType: part.mime,
        data: embedded.data,
        uri: resourceUri(part, index),
      }
    }
    if (part.mime.startsWith('audio/')) {
      return {
        type: 'audio',
        mimeType: part.mime,
        data: embedded.data,
      }
    }
    return {
      type: 'resource',
      resource: isTextMime(part.mime)
        ? {
            uri: resourceUri(part, index),
            mimeType: part.mime,
            text: decodeUtf8(embedded.data),
          }
        : {
            uri: resourceUri(part, index),
            mimeType: part.mime,
            blob: embedded.data,
          },
    }
  })
}

export function promptWithInputParts(text, parts = []) {
  const attachments = inputPartsToAcpBlocks(parts)
  if (!attachments.length) return String(text || '')
  return [
    { type: 'text', text: String(text || '') },
    ...attachments,
  ]
}

export function normalizeAcpPrompt(prompt) {
  if (!Array.isArray(prompt)) {
    return [{ type: 'text', text: String(prompt || '') }]
  }
  if (!prompt.length) throw new Error('ACP Prompt 不能为空')
  return prompt.map(block => {
    if (!block || typeof block !== 'object' || !block.type) {
      throw new Error('ACP Prompt 包含无效的 ContentBlock')
    }
    return block
  })
}

export function assertPromptCapabilities(blocks, capabilities = {}) {
  const prompt = capabilities.promptCapabilities || {}
  for (const block of blocks) {
    if (block.type === 'image' && prompt.image !== true) {
      throw new Error('当前后台 Agent 未声明 ACP 图片输入能力')
    }
    if (block.type === 'audio' && prompt.audio !== true) {
      throw new Error('当前后台 Agent 未声明 ACP 音频输入能力')
    }
    if (block.type === 'resource' && prompt.embeddedContext !== true) {
      throw new Error('当前后台 Agent 未声明 ACP 内嵌文件能力')
    }
  }
}

export function transformPromptText(prompt, transform) {
  if (!Array.isArray(prompt)) return transform(String(prompt || ''))
  let transformed = false
  const blocks = prompt.map(block => {
    if (!transformed && block?.type === 'text') {
      transformed = true
      return { ...block, text: transform(String(block.text || '')) }
    }
    return block
  })
  if (!transformed) blocks.unshift({ type: 'text', text: transform('') })
  return blocks
}

export function nonTextPromptBlocks(prompt) {
  return Array.isArray(prompt)
    ? prompt.filter(block => block?.type !== 'text')
    : []
}

export function appendPromptBlocks(prompt, blocks = []) {
  if (!blocks.length) return prompt
  const normalized = normalizeAcpPrompt(prompt)
  return [...normalized, ...blocks]
}
