import { readFile, stat } from 'node:fs/promises'
import { basename, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MAX_INPUT_FILE_BYTES,
  createInputFilePart,
  inputPartLabel,
  withAttachmentAnchors,
} from '../../shared/input-parts.mjs'

const MIME_BY_EXTENSION = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml'],
  ['.pdf', 'application/pdf'],
  ['.md', 'text/markdown'],
  ['.txt', 'text/plain'],
  ['.json', 'application/json'],
  ['.js', 'text/javascript'],
  ['.mjs', 'text/javascript'],
  ['.ts', 'text/typescript'],
  ['.tsx', 'text/typescript'],
  ['.jsx', 'text/javascript'],
  ['.html', 'text/html'],
  ['.css', 'text/css'],
  ['.csv', 'text/csv'],
  ['.yaml', 'application/yaml'],
  ['.yml', 'application/yaml'],
  ['.zip', 'application/zip'],
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'],
])

function extension(path) {
  const name = basename(path)
  const index = name.lastIndexOf('.')
  return index >= 0 ? name.slice(index).toLowerCase() : ''
}

export async function filePartFromPath(value, index = 0, reference = null) {
  const path = resolve(String(value || '').trim())
  const info = await stat(path)
  if (!info.isFile()) throw new Error(`不是普通文件：${path}`)
  if (info.size > MAX_INPUT_FILE_BYTES) {
    throw new Error(`文件超过 ${MAX_INPUT_FILE_BYTES / 1024 / 1024} MB 限制：${path}`)
  }
  const content = await readFile(path)
  const filename = basename(path)
  const mime = MIME_BY_EXTENSION.get(extension(path)) || 'application/octet-stream'
  const label = reference?.value || (
    mime.startsWith('image/') ? '' : `@${path}`
  )
  const part = createInputFilePart({
    mime,
    filename,
    url: `data:${mime};base64,${content.toString('base64')}`,
    path,
    reference: label,
  }, index)
  if (Number.isInteger(reference?.start)) {
    part.source.text.start = reference.start
  }
  if (Number.isInteger(reference?.end)) {
    part.source.text.end = reference.end
  }
  return part
}

function referencedPaths(text) {
  const values = []
  const pattern = /@(?:"([^"]+)"|'([^']+)'|([^\s]+))/g
  for (const match of String(text || '').matchAll(pattern)) {
    values.push({
      path: match[1] || match[2] || match[3],
      value: match[0],
      start: match.index,
      end: match.index + match[0].length,
    })
  }
  return values
}

function unescapePastedPath(value) {
  // UNC separators are literal: collapsing the leading pair would turn a
  // shared path into a different, root-relative path on Windows.
  if (/^\\\\[^\\]/.test(value)) return value
  return value.replace(/\\([\\ '"()&;])/g, '$1')
}

function pastedFilePaths(text) {
  let value = String(text || '').trim()
  const quoted = value.match(/^(?:"([\s\S]*)"|'([\s\S]*)')$/)
  if (quoted) value = quoted[1] ?? quoted[2]
  if (value.startsWith('file://')) {
    try {
      return [fileURLToPath(value)]
    } catch {
      return []
    }
  }
  const literal = value
  // Finder and common terminals paste shell-escaped absolute paths.
  value = unescapePastedPath(value)
  return isAbsolute(value) || /^\.\.?[\\/]/.test(value) ? [value, literal] : []
}

// Windows 不可用共享的 stat 可能返回 UNKNOWN，而不是 ENOENT。
// 只放行 UNC 查找失败；本地路径、权限及实际读取错误仍须报告。
function unavailablePath(error) {
  if (['ENOENT', 'ENOTDIR'].includes(error?.code)) return true
  return process.platform === 'win32'
    && error?.code === 'UNKNOWN'
    && error.syscall === 'stat'
    && /^\\\\(?![?.]\\)[^\\]+\\[^\\]+(?:\\|$)/.test(error.path || '')
}

// Windows 路径以 \ 分隔，C:\docs\(draft)\a.md 或 \\server\share 中的 \( 与 \\
// 并不是 shell 转义。UNC 路径保留原样；其他路径优先按转义解析（如 cat\ image.png），
// 该路径不存在时再尝试原样粘贴的文本。
async function filePartFromCandidates(paths, index) {
  let missing
  for (const path of new Set(paths)) {
    try {
      return await filePartFromPath(path, index)
    } catch (error) {
      if (!unavailablePath(error)) throw error
      missing ??= error
    }
  }
  throw missing
}

export function pastedPathReferences(text) {
  const references = []
  const pattern = /(^|\s)((?:file:\/\/|[A-Za-z]:[\\/]|\\\\|\/|\.\.?[\\/])(?:\\.|[^\s])+)/g
  for (const match of String(text || '').matchAll(pattern)) {
    const value = match[2]
    let path = unescapePastedPath(value)
    if (path.startsWith('file://')) {
      try {
        path = fileURLToPath(path)
      } catch {
        continue
      }
    }
    const start = match.index + match[1].length
    references.push({ path, start, end: start + value.length })
  }
  return references
}

export async function inputPartsFromText(
  text,
  staged = [],
  { attachmentOffset = staged.length } = {},
) {
  const content = String(text || '').trim()
  const parts = [...staged]
  const initialPartCount = parts.length
  const nextAttachmentIndex = () => (
    attachmentOffset + parts.length - initialPartCount
  )
  const paths = referencedPaths(content)
  const directPaths = paths.length ? [] : pastedFilePaths(content)
  if (directPaths.length) {
    try {
      parts.push(await filePartFromCandidates(directPaths, nextAttachmentIndex()))
      return withAttachmentAnchors(parts)
    } catch (error) {
      // A missing pasted path may still be intentional text. Existing paths
      // that are directories, too large, or unreadable remain real errors.
      if (!unavailablePath(error)) throw error
    }
  }
  if (!paths.length) {
    const replacements = []
    for (const reference of pastedPathReferences(content)) {
      try {
        const part = await filePartFromCandidates(
          [reference.path, content.slice(reference.start, reference.end)],
          nextAttachmentIndex(),
        )
        parts.push(part)
        replacements.push({
          ...reference,
          value: part.source.text.value,
        })
      } catch (error) {
        if (!unavailablePath(error)) throw error
      }
    }
    if (replacements.length) {
      let canonical = content
      for (const replacement of replacements.reverse()) {
        canonical = canonical.slice(0, replacement.start)
          + replacement.value
          + canonical.slice(replacement.end)
      }
      return withAttachmentAnchors([
        { type: 'text', text: canonical },
        ...parts,
      ])
    }
  }
  for (const reference of paths) {
    const resolved = resolve(reference.path)
    if (parts.some(part => part?.source?.path === resolved)) continue
    try {
      parts.push(await filePartFromPath(
        reference.path,
        nextAttachmentIndex(),
        reference,
      ))
    } catch (error) {
      // A literal @mention is still ordinary text. Only an existing path is
      // promoted into a file part; explicit attachment selection still
      // surfaces invalid paths to the user through filePartFromPath().
      if (!unavailablePath(error)) throw error
    }
  }
  return withAttachmentAnchors([
    ...(content ? [{ type: 'text', text: content }] : []),
    ...parts,
  ])
}

export function stagedInputSummary(parts = []) {
  return parts.map((part, index) => inputPartLabel(part, index)).join(' ')
}
