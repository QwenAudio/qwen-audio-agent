// Component-owned settings and UI state persistence.
//
// An embedding host must not have to know which file this product keeps its
// configuration in, nor where. It asks whether the Gateway can start, and if
// it cannot, it asks this package to collect what is missing. So persistence
// lives here — keyed by nothing but configDir — and every surface that needs
// it (the Gateway's startup gate, the settings form, the orb's position) goes
// through this one module rather than inventing its own.
//
// config.env is the carrier for settings, which keeps an embedded instance
// readable by the same tooling as a standalone install. Window state that has
// no meaning as an environment variable goes to ui-state.json beside it.
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'
import {
  replaceFileSync,
  withFileTransaction,
} from '../../shared/file-transaction-lock.mjs'
import { gatewaySetupStatus } from '../../shared/gateway-setup.mjs'
import {
  applySettingsEnvironment,
  parseSettings,
  updateSettingsContent,
} from './settings-config.mjs'
import { normalizeConversationSessionId } from '../../shared/conversation-session.mjs'

export const SETTINGS_FILE = 'config.env'
export const UI_STATE_FILE = 'ui-state.json'

// Everything written here is user configuration, including credentials, so it
// stays readable by its owner alone.
const PRIVATE_FILE_MODE = 0o600
const PRIVATE_DIRECTORY_MODE = 0o700

function requiredConfigDirectory(configDir) {
  const directory = String(configDir || '').trim()
  if (!directory) {
    const error = new Error(
      'createSettingsStore 需要显式的 configDir：嵌入宿主必须与独立版隔离数据目录',
    )
    error.code = 'QWAUDIO_GATEWAY_CONFIG_DIR_REQUIRED'
    throw error
  }
  return resolve(directory)
}

function readTextFile(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return ''
    throw error
  }
}

function writePrivateFile(path, content) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', mode: PRIVATE_FILE_MODE })
    chmodSync(temporary, PRIVATE_FILE_MODE)
    replaceFileSync(temporary, path)
    chmodSync(path, PRIVATE_FILE_MODE)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {}
    throw error
  }
}

/**
 * Settings and UI state for one instance, owned by this package.
 *
 * @param {object} options
 * @param {string} options.configDir Required. The instance data directory.
 * @param {string} [options.uiStateDir=options.configDir] Directory for
 *   ui-state.json. The desktop app shares config.env with the CLI's asset
 *   directory while window state stays in its own runtime directory; an
 *   embedding host keeps the default single directory.
 * @param {object} [options.env=process.env] Environment consulted for values
 *   the stored configuration leaves unset, and updated on save so an
 *   in-process restart observes what was just written.
 * @returns {{
 *   configDir: string, path: string, uiStatePath: string,
 *   load: () => object,
 *   save: (settings: object) => object,
 *   status: () => { ready: boolean, provider: string|null, missing: object[] },
 *   ready: () => boolean,
 *   loadUiState: () => object,
 *   saveUiState: (patch: object) => object,
 *   orbPosition: { load: () => object|null, save: (state: object) => object },
 *   conversationSession: { load: () => string, save: (sessionId: string) => string },
 * }}
 */
export function createSettingsStore({
  configDir,
  uiStateDir = configDir,
  env = process.env,
} = {}) {
  const directory = requiredConfigDirectory(configDir)
  const uiStateDirectory = requiredConfigDirectory(uiStateDir)
  const settingsPath = resolve(directory, SETTINGS_FILE)
  const uiStatePath = resolve(uiStateDirectory, UI_STATE_FILE)

  // Reading must never create anything: the startup gate runs before a host
  // has decided to start, and answering "not configured yet" is not a reason
  // to materialise a directory in the host's data path.
  const load = () => parseSettings(readTextFile(settingsPath), env)

  // The same readiness the startup gate reads: stored values first, then the
  // live environment for slots the file leaves unset — mirroring how the
  // Gateway itself loads config.env.
  const effectiveEnvironment = () => ({
    ...parseEnv(readTextFile(settingsPath)),
    ...env,
  })

  const ensureDirectory = () => {
    mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  }

  const loadUiState = () => {
    const content = readTextFile(uiStatePath)
    if (!content) return {}
    try {
      const value = JSON.parse(content)
      return value && typeof value === 'object' ? value : {}
    } catch {
      // UI state is a convenience, never a reason to fail a start. A corrupt
      // file is treated as absent and overwritten on the next save.
      return {}
    }
  }

  const saveUiState = patch => {
    mkdirSync(uiStateDirectory, {
      recursive: true,
      mode: PRIVATE_DIRECTORY_MODE,
    })
    const next = { ...loadUiState(), ...patch }
    writePrivateFile(uiStatePath, `${JSON.stringify(next, null, 2)}\n`)
    return next
  }

  return {
    configDir: directory,
    path: settingsPath,
    uiStatePath,
    load,

    save(settings) {
      ensureDirectory()
      const content = withFileTransaction(settingsPath, () => {
        const next = updateSettingsContent(readTextFile(settingsPath), settings)
        writePrivateFile(settingsPath, next)
        return next
      })
      // Keep this process consistent with what was just persisted, so a
      // subsequent in-process start does not keep serving the value the
      // environment happened to hold first.
      applySettingsEnvironment(settings, env)
      return parseSettings(content, env)
    },

    status: () => gatewaySetupStatus(effectiveEnvironment()),
    ready: () => gatewaySetupStatus(effectiveEnvironment()).ready,

    loadUiState,
    saveUiState,

    // Shaped for createOrbPlacement's storage contract, so the orb's position
    // persists without a host supplying anything.
    orbPosition: {
      load() {
        return loadUiState().orbPosition || null
      },
      save: state => saveUiState({ orbPosition: state }),
    },

    conversationSession: {
      load() {
        const current = normalizeConversationSessionId(
          loadUiState().conversationSessionId,
        )
        if (current) return current
        const created = randomUUID()
        saveUiState({ conversationSessionId: created })
        return created
      },
      save(value) {
        const sessionId = normalizeConversationSessionId(value)
        if (!sessionId) throw new TypeError('conversation session id is invalid')
        if (loadUiState().conversationSessionId !== sessionId) {
          saveUiState({ conversationSessionId: sessionId })
        }
        return sessionId
      },
    },
  }
}
