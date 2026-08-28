// 小型 JSON 快照的持久化基类。
//
// 它只负责「把一个 JSON 快照安全地存到磁盘、并在下次启动时读回来」，
// 对快照内部的数据模型完全不透明 —— serialise / deserialise 由使用方自己做。
//
// 写入范式对齐 frontend-notes 与 markdown-context-store：
//   · 原子写：tmp → replaceFileSync → chmod 600
//   · 损坏隔离：JSON 解析失败搬到 .corrupt-<ts>，服务继续用空快照运行
//   · I/O 失败降级：不阻塞主链路，setWarning + 关闭持久化
//   · mtime + 内容哈希双重检测 —— NTFS 与快速连续写入可能落同一时间刻度
//
// fileVersion 由子类指定，并且在数据模型变更时必须递增：版本不匹配会走
// quarantine 分支，把旧文件隔离并给出警告。这是刻意的 —— 否则旧文件会被当成
// 新格式逐条校验、全部丢弃、静默变成空快照。

import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { replaceFileSync } from '../../../shared/file-transaction-lock.mjs'

export class JsonSnapshotStore {
  constructor({
    filePath = null,
    fileVersion = 1,
    // 出现在警告文案里，便于运维一眼看出是哪份数据出了问题。
    label = '数据',
    // 快照里除 version 外必须存在的顶层对象字段，用于挡住格式不符的旧文件。
    requiredKeys = [],
    now = () => Date.now(),
    onWarning = warning => console.warn(warning.message),
  } = {}) {
    this.filePath = filePath
    this.fileVersion = fileVersion
    this.label = label
    this.requiredKeys = requiredKeys
    this.now = now
    this.onWarning = onWarning
    this.persistenceDisabled = false
    this.warning = null
    this.loadedMtimeMs = 0
    this.loadedContentHash = ''
  }

  configured() {
    return Boolean(this.filePath)
  }

  enabled() {
    return this.configured() && !this.persistenceDisabled
  }

  // 损坏、版本不符或缺字段时返回 null；上层据此决定是否走空快照。
  load() {
    if (!this.filePath) return null
    let raw
    try {
      raw = readFileSync(this.filePath, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') return null
      this.disablePersistence(`无法读取${this.label}文件：${error.message}`)
      return null
    }
    this.loadedMtimeMs = this.fileMtimeMs()
    this.loadedContentHash = createHash('sha1').update(raw).digest('hex')
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      this.quarantine(`${this.label}文件不是有效的 JSON：${error.message}`)
      return null
    }
    if (!parsed || parsed.version !== this.fileVersion || !this.hasRequiredKeys(parsed)) {
      this.quarantine(`${this.label}文件格式无效`)
      return null
    }
    return parsed
  }

  hasRequiredKeys(parsed) {
    return this.requiredKeys.every(key => (
      parsed[key]
      && typeof parsed[key] === 'object'
      && !Array.isArray(parsed[key])
    ))
  }

  // 上层在磁盘可能被其它 Gateway 更新过时调用。返回 true 表示磁盘有新变化，
  // 上层需要重新 load 并覆盖内存态。参照 frontend-notes 的 refreshIfChanged。
  hasChanged() {
    if (!this.enabled()) return false
    const mtimeMs = this.fileMtimeMs()
    if (mtimeMs === this.loadedMtimeMs) {
      return this.currentContentHash() !== this.loadedContentHash
    }
    return true
  }

  save(snapshot) {
    if (!this.filePath) return true
    if (this.persistenceDisabled) return false
    try {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 })
      const body = `${JSON.stringify({ version: this.fileVersion, ...snapshot }, null, 2)}\n`
      const temporary = `${this.filePath}.${process.pid}.tmp`
      writeFileSync(temporary, body, { encoding: 'utf8', mode: 0o600 })
      replaceFileSync(temporary, this.filePath)
      chmodSync(this.filePath, 0o600)
      this.loadedMtimeMs = this.fileMtimeMs()
      this.loadedContentHash = createHash('sha1').update(body).digest('hex')
      return true
    } catch (error) {
      this.disablePersistence(`无法写入${this.label}文件：${error.message}`)
      return false
    }
  }

  fileMtimeMs() {
    try {
      return statSync(this.filePath).mtimeMs
    } catch {
      return 0
    }
  }

  currentContentHash() {
    try {
      return createHash('sha1').update(readFileSync(this.filePath)).digest('hex')
    } catch {
      return ''
    }
  }

  quarantine(reason) {
    const quarantinePath = `${this.filePath}.corrupt-${this.now()}`
    try {
      renameSync(this.filePath, quarantinePath)
      this.setWarning(
        `${reason}；原文件已隔离为 ${quarantinePath}，服务将使用空${this.label}继续运行。`,
        quarantinePath,
      )
    } catch (error) {
      this.persistenceDisabled = true
      this.setWarning(
        `${reason}；隔离失败（${error.message}），已禁用${this.label}持久化以保护原文件。`,
      )
    }
  }

  disablePersistence(message) {
    this.persistenceDisabled = true
    this.setWarning(`${message}；已禁用${this.label}持久化，服务将继续运行。`)
  }

  setWarning(message, quarantinePath = null) {
    this.warning = { message, quarantinePath, at: this.now() }
    try {
      this.onWarning?.(this.warning)
    } catch {
      // Diagnostics must not prevent the voice service from starting.
    }
  }

  health() {
    return {
      ok: !this.warning,
      persistenceEnabled: this.enabled(),
      warning: this.warning,
    }
  }
}
