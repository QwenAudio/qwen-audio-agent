import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { logger } from '../core/logger.mjs'
import { dirname } from 'node:path'

const VERSION = 1

export class AcpSessionRegistry {
  constructor({ filePath = null } = {}) {
    this.filePath = filePath
    this.loaded = false
    this.coordinators = {}
    this.projects = {}
  }

  load() {
    if (this.loaded) return
    this.loaded = true
    if (!this.filePath) return
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8'))
      if (
        parsed?.version === VERSION
        && parsed.coordinators
        && typeof parsed.coordinators === 'object'
      ) {
        this.coordinators = parsed.coordinators
        this.projects = parsed.projects && typeof parsed.projects === 'object'
          ? parsed.projects
          : {}
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.warn('acp.session_index_read_failed', { error })
      }
    }
  }

  get(key) {
    this.load()
    const value = this.coordinators[String(key)]
    return value && typeof value === 'object' ? { ...value } : null
  }

  set(key, session) {
    this.load()
    this.coordinators[String(key)] = {
      sessionId: String(session.sessionId),
      cwd: String(session.cwd),
      updatedAt: Date.now(),
    }
    this.save()
  }

  delete(key) {
    this.load()
    delete this.coordinators[String(key)]
    this.save()
  }

  getProject(key) {
    this.load()
    const value = this.projects[String(key)]
    return value && typeof value === 'object' ? { ...value } : null
  }

  setProject(key, session) {
    this.setProjects([[key, session]])
  }

  setProjects(entries) {
    this.load()
    let changed = false
    for (const [key, session] of entries) {
      const sessionId = String(session.sessionId || '')
      const cwd = String(session.cwd || '')
      if (!sessionId || !cwd) continue
      this.projects[String(key)] = {
        sessionId,
        cwd,
        title: String(session.title || ''),
        updatedAt: Date.now(),
      }
      changed = true
    }
    if (changed) this.save()
  }

  save() {
    if (!this.filePath) return
    mkdirSync(dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify({
      version: VERSION,
      coordinators: this.coordinators,
      projects: this.projects,
    }, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    renameSync(temporary, this.filePath)
  }
}
