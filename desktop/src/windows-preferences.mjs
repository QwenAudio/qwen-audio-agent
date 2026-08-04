import { rename as nodeRename, readFile as nodeReadFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { writeFileAtomic as defaultWriteFileAtomic } from '../../shared/atomic-file.mjs'

const PREFERENCE_KEYS = new Set([
  'mode',
  'distribution',
  'externalGatewayOrigin',
  'openAtLogin',
  'orbVisible',
  'windowBounds',
])
const WINDOW_KEYS = new Set(['orb', 'settings', 'repair'])
const BOUNDS_KEYS = new Set(['x', 'y', 'width', 'height'])
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

export const DEFAULT_WINDOWS_PREFERENCES = Object.freeze({
  mode: 'managed',
  distribution: '',
  externalGatewayOrigin: '',
  openAtLogin: false,
  orbVisible: true,
  windowBounds: Object.freeze({
    orb: null,
    settings: null,
    repair: null,
  }),
})

function unknownKeys(value, allowed) {
  return Object.keys(value).filter(key => !allowed.has(key))
}

function cleanDistribution(value) {
  const text = String(value ?? '')
  if (
    text !== text.trim()
    || text.length > 256
    || CONTROL_CHARACTERS.test(text)
  ) throw new Error('Invalid WSL distribution preference')
  return text
}

function cleanExternalOrigin(value) {
  const text = String(value ?? '')
  if (!text) return ''
  let url
  try {
    url = new URL(text)
  } catch {
    throw new Error('External Gateway must be a loopback HTTP URL')
  }
  if (
    url.protocol !== 'http:'
    || !['127.0.0.1', 'localhost'].includes(url.hostname)
    || !url.port
    || url.pathname !== '/'
    || url.search
    || url.hash
    || url.username
    || url.password
  ) throw new Error('External Gateway must be a loopback HTTP URL')
  return url.origin
}

function cleanBounds(value, label) {
  if (value === null || value === undefined) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${label} window bounds`)
  }
  if (unknownKeys(value, BOUNDS_KEYS).length) {
    throw new Error(`Unknown ${label} window bounds key`)
  }
  const result = {}
  for (const key of BOUNDS_KEYS) {
    const number = Number(value[key])
    if (!Number.isSafeInteger(number)) {
      throw new Error(`Invalid ${label} window bounds`)
    }
    result[key] = number
  }
  if (
    result.width < 1
    || result.height < 1
    || result.width > 100_000
    || result.height > 100_000
    || Math.abs(result.x) > 10_000_000
    || Math.abs(result.y) > 10_000_000
  ) throw new Error(`Invalid ${label} window bounds`)
  return result
}

function cleanWindowBounds(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid windowBounds preference')
  }
  const unknown = unknownKeys(value, WINDOW_KEYS)
  if (unknown.length) throw new Error(`Unknown window bounds key: ${unknown[0]}`)
  return Object.fromEntries([...WINDOW_KEYS].map(key => [
    key,
    cleanBounds(value[key], key),
  ]))
}

export function validateWindowsPreferences(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Windows preferences must be an object')
  }
  const unknown = unknownKeys(value, PREFERENCE_KEYS)
  if (unknown.length) throw new Error(`Unknown preference key: ${unknown[0]}`)
  const merged = {
    ...DEFAULT_WINDOWS_PREFERENCES,
    ...value,
    windowBounds: {
      ...DEFAULT_WINDOWS_PREFERENCES.windowBounds,
      ...(value.windowBounds || {}),
    },
  }
  if (!['managed', 'external'].includes(merged.mode)) {
    throw new Error('Invalid Windows runtime mode preference')
  }
  if (typeof merged.openAtLogin !== 'boolean') {
    throw new Error('Invalid openAtLogin preference')
  }
  if (typeof merged.orbVisible !== 'boolean') {
    throw new Error('Invalid orbVisible preference')
  }
  return {
    mode: merged.mode,
    distribution: cleanDistribution(merged.distribution),
    externalGatewayOrigin: cleanExternalOrigin(merged.externalGatewayOrigin),
    openAtLogin: merged.openAtLogin,
    orbVisible: merged.orbVisible,
    windowBounds: cleanWindowBounds(merged.windowBounds),
  }
}

function clonePreferences(value) {
  return structuredClone(value)
}

export class WindowsPreferencesStore {
  constructor({
    app,
    filename = 'windows-preferences.json',
    readFile = (path, encoding) => nodeReadFile(path, encoding),
    writeFileAtomic = defaultWriteFileAtomic,
    rename = nodeRename,
    resolvePath = resolve,
    now = Date.now,
    logger = console,
  } = {}) {
    if (!app?.getPath) throw new TypeError('Electron app is required')
    this.path = resolvePath(app.getPath('userData'), filename)
    this.readFile = readFile
    this.writeFileAtomic = writeFileAtomic
    this.rename = rename
    this.now = now
    this.logger = logger
    this.writeQueue = Promise.resolve()
  }

  async read() {
    let content
    try {
      content = await this.readFile(this.path, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return clonePreferences(DEFAULT_WINDOWS_PREFERENCES)
      }
      throw error
    }
    try {
      return validateWindowsPreferences(JSON.parse(content))
    } catch {
      const stamp = new Date(this.now()).toISOString().replace(/[-:.]/g, '')
      const diagnosticPath = `${this.path}.corrupt-${stamp}`
      try {
        await this.rename(this.path, diagnosticPath)
      } catch {
        // The fallback is still safe; do not include file contents or OS errors.
      }
      this.logger?.warn?.('Windows preferences were invalid and were preserved for diagnostics')
      return clonePreferences(DEFAULT_WINDOWS_PREFERENCES)
    }
  }

  write(update = {}) {
    if (!update || typeof update !== 'object' || Array.isArray(update)) {
      return Promise.reject(new Error('Windows preference update must be an object'))
    }
    const unknown = unknownKeys(update, PREFERENCE_KEYS)
    if (unknown.length) {
      return Promise.reject(new Error(`Unknown preference key: ${unknown[0]}`))
    }
    const operation = this.writeQueue.then(async () => {
      const current = await this.read()
      const next = validateWindowsPreferences({
        ...current,
        ...update,
        windowBounds: update.windowBounds
          ? { ...current.windowBounds, ...update.windowBounds }
          : current.windowBounds,
      })
      await this.writeFileAtomic(
        this.path,
        `${JSON.stringify(next, null, 2)}\n`,
        { mode: 0o600 },
      )
      return clonePreferences(next)
    })
    this.writeQueue = operation.catch(() => {})
    return operation
  }
}

export function readOpenAtLogin(app) {
  if (!app?.getLoginItemSettings) throw new TypeError('Electron app is required')
  return app.getLoginItemSettings().openAtLogin === true
}

export function applyOpenAtLogin(app, enabled, startupArguments) {
  if (startupArguments !== undefined) {
    throw new Error('Caller-provided startup arguments are not allowed')
  }
  if (typeof enabled !== 'boolean') throw new TypeError('enabled must be boolean')
  if (!app?.setLoginItemSettings) throw new TypeError('Electron app is required')
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: process.execPath,
    args: ['--startup'],
  })
  return readOpenAtLogin(app)
}
