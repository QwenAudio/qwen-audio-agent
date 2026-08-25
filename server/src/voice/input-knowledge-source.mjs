import { createHash } from 'node:crypto'
import {
  inputFileParts,
  inputPartLabel,
  inputPartRef,
  parseDataUrl,
} from '../../../shared/input-parts.mjs'

function sourceId(part, parsed) {
  const stable = String(
    part?.source?.path
    || part?.filename
    || inputPartRef(part)
    || '',
  ).trim()
  const identityHash = createHash('sha256')
    .update(stable || parsed.data)
    .digest('hex')
    .slice(0, 24)
  return `attachment:${identityHash}`
}

export function knowledgeSourcesFromInputParts(parts = []) {
  return inputFileParts(parts).map((part, index) => {
    const parsed = parseDataUrl(part.url)
    if (!parsed) {
      const error = new Error('Knowledge indexing accepts inline file content only.')
      error.code = 'knowledge_input_not_inline'
      throw error
    }
    return {
      id: sourceId(part, parsed),
      filename: String(part.filename || inputPartLabel(part, index)).trim(),
      mimeType: String(part.mime || parsed.mimeType).trim().toLowerCase(),
      content: Buffer.from(parsed.data, 'base64'),
      kind: 'attachment',
    }
  })
}
