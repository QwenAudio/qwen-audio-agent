import { logger } from '../core/logger.mjs'
import { VersionedJsonStore } from '../core/versioned-json-store.mjs'

const VERSION = 1

export class AcpSessionRegistry {
  constructor({
    filePath = null,
    onWarning = warning => logger.warn(
      'acp.session_index_persistence_warning',
      { warning },
    ),
  } = {}) {
    this.filePath = filePath
    this.store = new VersionedJsonStore({
      filePath,
      version: VERSION,
      label: 'ACP Session 索引',
      onWarning,
    })
    this.loaded = false
    this.coordinators = {}
    this.projects = {}
  }

  load() {
    if (this.loaded) return
    this.loaded = true
    const parsed = this.store.load({
      fallback: () => ({ coordinators: {}, projects: {} }),
      validate: value => Boolean(
        value.coordinators
        && typeof value.coordinators === 'object'
        && !Array.isArray(value.coordinators)
        && (value.projects === undefined || (
          value.projects
          && typeof value.projects === 'object'
          && !Array.isArray(value.projects)
        )),
      ),
    })
    this.coordinators = parsed.coordinators
    this.projects = parsed.projects || {}
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
      ...(Number.isInteger(session.contractVersion)
        ? { contractVersion: session.contractVersion }
        : {}),
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
    this.store.save({
      coordinators: this.coordinators,
      projects: this.projects,
    })
  }

  health() {
    return this.store.health()
  }
}
