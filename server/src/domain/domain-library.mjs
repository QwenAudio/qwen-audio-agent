// 领域资料库 —— 用户给的 policy / 手册 / 教材落盘 + 一份带摘要的清单。
//
// 它解决的是「用户给我一份手册，助手要知道这份手册是什么、并且能让后端去查」。
//
// ★ 落盘位置刻意选在后端的共享 workspace 下。
// defaultBackendWorkspace() 是所有后端默认的 cwd，文件放这里，后端拿到路径就能
// 自己 grep / read —— 这正是「前端只知道有什么，细节丢给后端」的落点。后端有
// 自己的文件索引能力（Claude Code 会 grep、OpenClaw 有 recall store），前端不该
// 再造一套检索。external 模式的远程后端可能读不到本机路径，协调器 prompt 里
// 已经交代了「若后台主机无法访问该路径，再如实说明」，走那条既有的降级。
//
// ★ 资料不进 MEMORY.md。
// 这是「knowledge ≠ memory」那条界线：手册是外部的、静态的、多用户共享的知识；
// memory 是这个用户的、会演化的个人事实。混进去有两个后果 —— MEMORY.md 的
// 8000 字符预算被一份手册吃光；consolidation 会去「整理」手册内容，而那是会
// 重写和删除的操作，用在规章上是灾难。
//
// ★ 不过敏感内容闸门。
// 记忆侧那道闸门会把「密码」「验证码」判为敏感，但手册里出现这些词是正常的
// （「重置密码流程」「验证码有效期」）。资料是用户主动导入的文档，不是从对话里
// 推断出来的，用记忆侧的标准会大面积误伤。摘要（LLM 产出）仍然要过闸门。

import { createHash, randomUUID } from 'node:crypto'
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { basename, extname, join, parse, resolve } from 'node:path'
import { JsonSnapshotStore } from '../core/json-snapshot-store.mjs'

const FILE_VERSION = 1
const MAX_ENTRIES_PER_OWNER = 40
const MAX_FILE_BYTES = 10 * 1024 * 1024
const MAX_TITLE_CHARS = 60
const MAX_GIST_CHARS = 80
const MAX_SECTIONS = 12
const MAX_SECTION_CHARS = 24
const DEFAULT_LIMIT = 5
const MAX_LIMIT = 10

// 只直接收文本。PDF / Word 这类要先转换，而转换交给后端 Agent 做 ——
// 它有文件读写与命令执行能力，前端不该为此引一堆解析库。
const TEXT_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.text',
  '.json', '.yaml', '.yml', '.csv', '.tsv',
  '.html', '.htm', '.xml', '.rst', '.org',
])

// 能交给后端提取文字的格式。刻意不含图片与音视频：那不是「提取文字」，
// 是另一件事，含糊地派出去只会得到一段模型编的描述。
const CONVERTIBLE_EXTENSIONS = new Set([
  '.pdf', '.doc', '.docx', '.ppt', '.pptx', '.odt', '.rtf', '.epub',
])

// text        → 直接收
// convertible → 先派给后端转成文本，再收转换产物
// unsupported → 明确拒收
export function classifySource(sourcePath) {
  const extension = extname(String(sourcePath || '')).toLowerCase()
  if (TEXT_EXTENSIONS.has(extension)) return 'text'
  if (CONVERTIBLE_EXTENSIONS.has(extension)) return 'convertible'
  return 'unsupported'
}

export class DomainImportError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function text(value, maxChars) {
  return [...String(value || '').replace(/\s+/g, ' ').trim()]
    .slice(0, maxChars)
    .join('')
}

function bare(value) {
  return String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

// 保留中文与字母数字，去掉路径分隔符与控制字符。刻意不做音译或哈希化 ——
// 这个名字会出现在给后端的路径里，可读性直接决定 objective 写出来是否自然。
function safeFilename(name) {
  const cleaned = String(name || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\]/g, '-')
    .replace(/^\.+/, '')
    .trim()
  const fallback = `document-${Date.now()}`
  return [...(cleaned || fallback)].slice(0, 120).join('')
}

export class DomainLibrary {
  constructor({
    // 资料本体落这里，必须是后端读得到的目录
    documentDirectory,
    indexPath = null,
    store = null,
    now = () => Date.now(),
    onWarning = warning => console.warn(warning.message),
    maxFileBytes = MAX_FILE_BYTES,
    maxPerOwner = MAX_ENTRIES_PER_OWNER,
  } = {}) {
    this.documentDirectory = documentDirectory
    this.store = store || (indexPath
      ? new JsonSnapshotStore({
          filePath: indexPath,
          fileVersion: FILE_VERSION,
          label: '资料清单',
          requiredKeys: ['owners'],
          now,
          onWarning,
        })
      : null)
    this.now = now
    this.maxFileBytes = maxFileBytes
    this.maxPerOwner = maxPerOwner
    this.owners = new Map()
    this.loaded = false
  }

  configured() {
    return Boolean(this.documentDirectory)
  }

  load() {
    if (this.loaded && !this.store?.hasChanged()) return
    this.loaded = true
    this.owners = new Map()
    const snapshot = this.store?.load()
    if (!snapshot) return
    for (const [ownerId, entries] of Object.entries(snapshot.owners || {})) {
      if (!Array.isArray(entries)) continue
      const restored = entries.map(entry => this.sanitise(entry)).filter(Boolean)
      if (restored.length) this.owners.set(String(ownerId), restored)
    }
  }

  sanitise(entry) {
    const id = text(entry?.id, 64)
    const path = String(entry?.path || '').trim()
    const filename = text(entry?.filename, 160)
    if (!id || !path || !filename) return null
    const importedAt = Number(entry?.importedAt)
    return {
      id,
      title: text(entry?.title, MAX_TITLE_CHARS) || filename,
      gist: text(entry?.gist, MAX_GIST_CHARS),
      sections: Array.isArray(entry?.sections)
        ? entry.sections
          .map(section => text(section, MAX_SECTION_CHARS))
          .filter(Boolean)
          .slice(0, MAX_SECTIONS)
        : [],
      path,
      filename,
      bytes: Number(entry?.bytes) > 0 ? Math.floor(Number(entry.bytes)) : 0,
      importedAt: Number.isFinite(importedAt) && importedAt > 0 ? importedAt : this.now(),
      source: String(entry?.source || '').trim(),
      // fingerprint 必须一起存回来：重复导入检测靠它，丢了就会在重启后把同一份
      // 手册再收一遍。
      fingerprint: text(entry?.fingerprint, 64),
      summarised: Boolean(entry?.summarised),
    }
  }

  save() {
    if (!this.store?.enabled()) return false
    const owners = {}
    for (const [ownerId, entries] of this.owners) {
      if (entries.length) owners[ownerId] = entries
    }
    return this.store.save({ owners })
  }

  // 把一份本地文件收进资料库。同步完成，不调模型 —— 没配 API key 时资料仍然
  // 能导入并交给后端，只是没有摘要，这是刻意的降级顺序。
  import({ ownerId, sourcePath } = {}) {
    if (!this.configured()) {
      throw new DomainImportError('library_unavailable', '资料库未配置存放目录。')
    }
    const safeOwnerId = String(ownerId || '')
    if (!safeOwnerId) {
      throw new DomainImportError('missing_owner', '缺少归属用户。')
    }
    // 空输入必须在 resolve 之前拦掉：resolve('') 返回的是进程 cwd，那是个存在的
    // 目录，会一路走到 statSync 才因为「不是文件」被拒，错误信息变成 not_a_file
    // —— 用户看到的提示就对不上他实际做错的事。
    const raw = String(sourcePath || '').trim()
    if (!raw) {
      throw new DomainImportError('invalid_path', '需要一个具体的文件路径。')
    }
    const absolute = resolve(raw)
    // 用 parse().root 判断而不是比 '/'：Windows 上根是 'C:\\'，写死斜杠在那边
    // 永不生效。
    if (absolute === parse(absolute).root) {
      throw new DomainImportError('invalid_path', '需要一个具体的文件路径。')
    }

    let stats
    try {
      stats = statSync(absolute)
    } catch {
      throw new DomainImportError('not_found', `找不到这个文件：${absolute}`)
    }
    if (!stats.isFile()) {
      throw new DomainImportError('not_a_file', '这个路径不是一个文件。')
    }
    if (stats.size <= 0) {
      throw new DomainImportError('empty_file', '这个文件是空的。')
    }
    if (stats.size > this.maxFileBytes) {
      throw new DomainImportError(
        'too_large',
        `文件超过 ${Math.floor(this.maxFileBytes / 1024 / 1024)} MB 上限。`,
      )
    }
    const extension = extname(absolute).toLowerCase()
    if (!TEXT_EXTENSIONS.has(extension)) {
      throw new DomainImportError(
        classifySource(absolute) === 'convertible' ? 'needs_conversion' : 'unsupported_type',
        classifySource(absolute) === 'convertible'
          ? `${extension} 需要先提取文字，这一步交给后台处理。`
          : `不支持 ${extension} 这类文件。`,
      )
    }

    this.load()
    const entries = this.owners.get(safeOwnerId) || []
    const fingerprint = createHash('sha1')
      .update(readFileSync(absolute))
      .digest('hex')
    // 同一份文件重复导入就覆盖，不追加 —— 用户更新了手册再导一次是常见操作。
    const existing = entries.find(entry => entry.fingerprint === fingerprint)
      || entries.find(entry => entry.source === absolute)

    const filename = this.uniqueFilename(safeOwnerId, absolute, existing)
    const destination = join(this.documentDirectory, filename)
    try {
      mkdirSync(this.documentDirectory, { recursive: true, mode: 0o700 })
      copyFileSync(absolute, destination)
    } catch (error) {
      throw new DomainImportError('copy_failed', `无法复制到资料库：${error.message}`)
    }

    const entry = {
      id: existing?.id || randomUUID().slice(0, 12),
      title: existing?.title || basename(absolute, extension),
      gist: existing?.gist || '',
      sections: existing?.sections || [],
      path: destination,
      filename,
      bytes: stats.size,
      importedAt: this.now(),
      source: absolute,
      fingerprint,
      // 内容变了就要重新摘要
      summarised: Boolean(existing?.summarised && existing.fingerprint === fingerprint),
    }
    const next = entries.filter(item => item.id !== entry.id)
    next.unshift(entry)
    // 超出上限时丢掉最久没导入的，但只丢索引，不删文件 —— 用户的文件不该被
    // 一次静默的容量回收删掉。
    this.owners.set(safeOwnerId, next.slice(0, this.maxPerOwner))
    this.save()
    return entry
  }

  uniqueFilename(ownerId, sourcePath, existing) {
    if (existing) return existing.filename
    const extension = extname(sourcePath).toLowerCase()
    const stem = safeFilename(basename(sourcePath, extname(sourcePath)))
    const taken = new Set()
    for (const entries of this.owners.values()) {
      for (const entry of entries) taken.add(entry.filename)
    }
    let candidate = `${stem}${extension}`
    let index = 2
    while (taken.has(candidate)) {
      candidate = `${stem}-${index}${extension}`
      index += 1
    }
    return candidate
  }

  // 为一份待转换的文件分配转换产物的落点。返回的路径直接写进给后端的 objective，
  // 所以文件名要可读；防冲突复用 uniqueFilename，避免两次转换互相覆盖。
  //
  // 注意这里只是「取一个名字」，不占位、不建文件 —— 后端可能转失败，留一个空
  // 文件在资料目录里比什么都没有更糟。真正的收录发生在转换成功之后。
  conversionTarget({ ownerId, sourcePath } = {}) {
    if (!this.configured()) {
      throw new DomainImportError('library_unavailable', '资料库未配置存放目录。')
    }
    const absolute = resolve(String(sourcePath || '').trim())
    if (classifySource(absolute) !== 'convertible') {
      throw new DomainImportError('not_convertible', '这类文件不需要、也无法交给后台提取文字。')
    }
    this.load()
    const stem = safeFilename(basename(absolute, extname(absolute)))
    const taken = new Set()
    for (const entries of this.owners.values()) {
      for (const entry of entries) taken.add(entry.filename)
    }
    let filename = `${stem}.md`
    let index = 2
    while (taken.has(filename)) {
      filename = `${stem}-${index}.md`
      index += 1
    }
    return { filename, path: join(this.documentDirectory, filename), ownerId }
  }

  attachSummary({ ownerId, id, title, gist, sections } = {}) {
    this.load()
    const entries = this.owners.get(String(ownerId || '')) || []
    const entry = entries.find(item => item.id === String(id || ''))
    if (!entry) return null
    if (title) entry.title = text(title, MAX_TITLE_CHARS)
    if (gist) entry.gist = text(gist, MAX_GIST_CHARS)
    if (Array.isArray(sections)) {
      entry.sections = sections
        .map(section => text(section, MAX_SECTION_CHARS))
        .filter(Boolean)
        .slice(0, MAX_SECTIONS)
    }
    entry.summarised = true
    this.save()
    return entry
  }

  list(ownerId) {
    this.load()
    return [...(this.owners.get(String(ownerId || '')) || [])]
  }

  get(ownerId, id) {
    return this.list(ownerId).find(entry => entry.id === String(id || '')) || null
  }

  pendingSummary(ownerId) {
    return this.list(ownerId).filter(entry => !entry.summarised)
  }

  // 与会话摘要同一套浅检索：去标点后子串匹配，命中标题的排在前面。
  search({ ownerId, keyword = '', limit = DEFAULT_LIMIT } = {}) {
    const entries = this.list(ownerId)
    const size = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT)
    const needle = bare(keyword)
    if (!needle) return entries.slice(0, size)
    const scored = []
    for (const entry of entries) {
      const inTitle = bare(entry.title).includes(needle)
        || bare(entry.filename).includes(needle)
      const inSections = entry.sections.some(section => bare(section).includes(needle))
      const inGist = bare(entry.gist).includes(needle)
      if (!inTitle && !inSections && !inGist) continue
      scored.push({ entry, rank: inTitle ? 0 : (inSections ? 1 : 2) })
    }
    return scored
      .sort((left, right) => (left.rank - right.rank)
        || (right.entry.importedAt - left.entry.importedAt))
      .slice(0, size)
      .map(item => item.entry)
  }

  // 移除时连文件一起删：这是用户显式要求的删除，不是容量回收。
  remove({ ownerId, id } = {}) {
    this.load()
    const safeOwnerId = String(ownerId || '')
    const entries = this.owners.get(safeOwnerId) || []
    const entry = entries.find(item => item.id === String(id || ''))
    if (!entry) return null
    this.owners.set(safeOwnerId, entries.filter(item => item.id !== entry.id))
    try {
      rmSync(entry.path, { force: true })
    } catch {
      // 文件删不掉不该阻止索引移除：清单里看不见就是用户要的效果。
    }
    this.save()
    return entry
  }

  // 读一段内容供摘要使用。只读头部：手册的开篇通常就是范围与目录。
  readHead(entry, maxChars) {
    try {
      const raw = readFileSync(entry.path, 'utf8')
      // NUL 字节说明这其实是二进制，扩展名骗了我们
      if (raw.includes('\u0000')) return ''
      return [...raw].slice(0, maxChars).join('')
    } catch {
      return ''
    }
  }

  health() {
    this.load()
    return {
      ...(this.store?.health() || { ok: true, persistenceEnabled: false, warning: null }),
      configured: this.configured(),
      documentDirectory: this.documentDirectory || null,
      owners: this.owners.size,
    }
  }
}

export const DOMAIN_LIMITS = Object.freeze({
  MAX_ENTRIES_PER_OWNER,
  MAX_FILE_BYTES,
  MAX_TITLE_CHARS,
  MAX_GIST_CHARS,
  MAX_SECTIONS,
  MAX_SECTION_CHARS,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  TEXT_EXTENSIONS,
})
