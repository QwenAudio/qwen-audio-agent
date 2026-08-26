import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import {
  mkdir,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { dirname } from 'node:path'

const VERSION = 1

export class TaskStore {
  constructor({
    filePath = null,
    now = () => Date.now(),
    onWarning = warning => console.warn(warning.message),
    deferredDelayMs = 250,
  } = {}) {
    this.filePath = filePath
    this.now = now
    this.onWarning = onWarning
    this.warning = null
    this.persistenceDisabled = false
    this.deferredDelayMs = deferredDelayMs
    this.deferredTimer = null
    this.deferredContent = null
    this.writeGeneration = 0
    this.deferredWrites = Promise.resolve()
    this.nextTaskNumber = 1
  }

  setWarning(message, quarantinePath = null) {
    this.warning = { message, quarantinePath, at: this.now() }
    try {
      this.onWarning?.(this.warning)
    } catch {
      // Diagnostics must not prevent the service from starting.
    }
  }

  quarantine(reason) {
    const quarantinePath = `${this.filePath}.corrupt-${this.now()}`
    try {
      renameSync(this.filePath, quarantinePath)
      this.setWarning(
        `${reason}；原文件已隔离为 ${quarantinePath}，服务将使用空任务状态继续运行。`,
        quarantinePath,
      )
    } catch (error) {
      this.persistenceDisabled = true
      this.setWarning(
        `${reason}；隔离失败（${error.message}），已禁用任务持久化以保护原文件。`,
      )
    }
  }

  load() {
    if (!this.filePath || this.persistenceDisabled) return []
    let parsed
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') return []
      if (error instanceof SyntaxError) {
        this.quarantine(`任务状态文件不是有效的 JSON：${error.message}`)
        return []
      }
      this.persistenceDisabled = true
      this.setWarning(`无法读取任务状态文件：${error.message}`)
      return []
    }
    if (
      !parsed
      || parsed.version !== VERSION
      || !Array.isArray(parsed.tasks)
    ) {
      this.quarantine('任务状态文件格式无效')
      return []
    }
    this.nextTaskNumber = Number.isInteger(parsed.nextTaskNumber)
      ? parsed.nextTaskNumber
      : Number.isInteger(parsed.nextJobNumber)
        ? parsed.nextJobNumber
      : 1
    return parsed.tasks.filter(task => task && typeof task === 'object')
  }

  save(tasks, { nextTaskNumber = this.nextTaskNumber } = {}) {
    if (!this.filePath || this.persistenceDisabled) return
    this.nextTaskNumber = nextTaskNumber
    clearTimeout(this.deferredTimer)
    this.deferredTimer = null
    this.deferredContent = null
    this.writeGeneration += 1
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      const temporary = `${this.filePath}.${process.pid}.tmp`
      writeFileSync(
        temporary,
        `${JSON.stringify({
          version: VERSION,
          nextTaskNumber,
          tasks,
        }, null, 2)}\n`,
        { encoding: 'utf8', mode: 0o600 },
      )
      renameSync(temporary, this.filePath)
    } catch (error) {
      this.persistenceDisabled = true
      this.setWarning(`无法保存任务状态：${error.message}`)
    }
  }

  saveDeferred(tasks, { nextTaskNumber = this.nextTaskNumber } = {}) {
    if (!this.filePath || this.persistenceDisabled) return
    this.nextTaskNumber = nextTaskNumber
    this.deferredContent = `${JSON.stringify({
      version: VERSION,
      nextTaskNumber,
      tasks,
    }, null, 2)}\n`
    clearTimeout(this.deferredTimer)
    this.deferredTimer = setTimeout(() => {
      this.deferredTimer = null
      this.startDeferredWrite()
    }, this.deferredDelayMs)
    this.deferredTimer.unref?.()
  }

  startDeferredWrite() {
    const content = this.deferredContent
    if (!content || !this.filePath || this.persistenceDisabled) {
      return this.deferredWrites
    }
    this.deferredContent = null
    const generation = ++this.writeGeneration
    const temporary = `${this.filePath}.${process.pid}.${generation}.tmp`
    const operation = async () => {
      try {
        await mkdir(dirname(this.filePath), { recursive: true })
        await writeFile(temporary, content, {
          encoding: 'utf8',
          mode: 0o600,
        })
        if (generation !== this.writeGeneration) {
          await unlink(temporary).catch(() => {})
          return
        }
        await rename(temporary, this.filePath)
      } catch (error) {
        await unlink(temporary).catch(() => {})
        if (generation !== this.writeGeneration) return
        this.persistenceDisabled = true
        this.setWarning(`无法保存任务状态：${error.message}`)
      }
    }
    this.deferredWrites = this.deferredWrites.then(operation, operation)
    return this.deferredWrites
  }

  async flush() {
    clearTimeout(this.deferredTimer)
    this.deferredTimer = null
    this.startDeferredWrite()
    await this.deferredWrites
  }

  health() {
    return {
      ok: !this.warning,
      persistenceEnabled: Boolean(this.filePath) && !this.persistenceDisabled,
      warning: this.warning,
    }
  }
}
