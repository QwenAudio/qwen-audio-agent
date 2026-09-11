import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

// Append-only JSONL diagnostics shared by background learning and summarisation.
// Audit failures must never break the operation being recorded.
export class OperationAudit {
  constructor({
    filePath = null,
    now = () => Date.now(),
    onWarning = warning => console.warn(warning.message),
  } = {}) {
    this.filePath = filePath
    this.now = now
    this.onWarning = onWarning
    this.disabled = false
    this.warning = null
  }

  record(event) {
    if (!this.filePath || this.disabled) return false
    try {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 })
      appendFileSync(
        this.filePath,
        `${JSON.stringify({ at: new Date(this.now()).toISOString(), ...event })}\n`,
        { encoding: 'utf8', mode: 0o600 },
      )
      return true
    } catch (error) {
      this.disabled = true
      this.warning = {
        message: `无法写入审计日志：${error.message}；已停用审计，当前操作不受影响。`,
        at: this.now(),
      }
      try {
        this.onWarning?.(this.warning)
      } catch {
        // Diagnostics must not prevent the operation being recorded.
      }
      return false
    }
  }

  health() {
    return {
      ok: !this.warning,
      configured: Boolean(this.filePath),
      enabled: Boolean(this.filePath) && !this.disabled,
      warning: this.warning,
    }
  }
}
