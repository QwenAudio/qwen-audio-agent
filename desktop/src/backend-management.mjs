import { existsSync, readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { mergeSearchPath } from '../../shared/path-environment.mjs'
import { withBackendLifecycle } from '../../shared/backend-install.mjs'
import { backendDefinition } from '../../shared/backend-catalog.mjs'
import { detectBackendSetups } from './backend-detection.mjs'
import { createBackendInstaller } from './backend-installer.mjs'
import { openBackendConfiguration } from './backend-configuration.mjs'

const DEFAULT_REPORT_TTL_MS = 10 * 60 * 1000

export function desktopBackendEnvironment({
  configPath,
  env = process.env,
  readFile = readFileSync,
  exists = existsSync,
} = {}) {
  const configured = configPath && exists(configPath)
    ? parseEnv(readFile(configPath, 'utf8'))
    : {}
  const filtered = Object.fromEntries(
    Object.entries(configured).filter(([, value]) => value !== ''),
  )
  const result = {
    ...env,
    ...filtered,
    QWEN_AUDIO_AGENT_DESKTOP_INSTALLED_ONLY: '1',
  }
  if (result.Path && !result.PATH) result.PATH = result.Path
  delete result.Path
  return result
}

export function createDesktopBackendManagement({
  configPath,
  env = process.env,
  platform = process.platform,
  reportTtlMs = DEFAULT_REPORT_TTL_MS,
  now = Date.now,
  detect = detectBackendSetups,
  enrichReport = withBackendLifecycle,
  createInstaller = createBackendInstaller,
  openConfiguration = openBackendConfiguration,
  confirmScript = async () => false,
  onInstallProgress = () => {},
  onConfigured = () => {},
} = {}) {
  const currentEnvironment = () => desktopBackendEnvironment({ configPath, env })
  let reportCache = null
  let reportPending = null

  async function runDetection() {
    const result = await detect({ env: currentEnvironment() })
    if (result.path) {
      env.PATH = mergeSearchPath(env.PATH, result.path, { platform })
    }
    return enrichReport(result.report, { env: currentEnvironment() })
  }

  async function detectBackends({ force = false } = {}) {
    const currentTime = now()
    if (
      !force
      && reportCache
      && currentTime - reportCache.time < reportTtlMs
    ) {
      return reportCache.report
    }
    if (reportPending) return reportPending
    reportPending = runDetection().then(report => {
      reportCache = { report, time: now() }
      return report
    }).finally(() => {
      reportPending = null
    })
    return reportPending
  }

  const installer = createInstaller({
    env: currentEnvironment,
    platform,
    confirmScript,
  })

  async function install(payload) {
    const id = typeof payload === 'string' ? payload : payload?.backend
    const definition = backendDefinition(id)
    if (!definition) throw new Error(`不支持的后台：${String(id || '')}`)
    const support = installer.support(definition.id)
    if (!support.supported) {
      return {
        ok: false,
        error: { code: 'UNSUPPORTED', message: support.reason },
      }
    }
    return installer.install(definition.id, {
      onProgress: progress => onInstallProgress({
        backend: definition.id,
        ...progress,
      }),
      inspect: async () => {
        const report = await runDetection()
        reportCache = { report, time: now() }
        return report
      },
    })
  }

  async function configure(payload) {
    const id = typeof payload === 'string' ? payload : payload?.backend
    const definition = backendDefinition(id)
    if (!definition) throw new Error(`不支持的后台：${String(id || '')}`)
    const result = await openConfiguration(definition.id, {
      env: currentEnvironment(),
      platform,
    })
    onConfigured({ backend: definition.id, result })
    return result
  }

  return { detectBackends, install, configure }
}
