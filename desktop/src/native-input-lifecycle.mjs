import { randomUUID } from 'node:crypto'

const ACTIONS = new Set(['status', 'install', 'repair', 'uninstall'])

export class NativeInputLifecycle {
  constructor({ host } = {}) {
    this.host = host
    this.current = {
      installed: false,
      registered: false,
      enabled: false,
      version: '',
      state: 'unknown',
    }
  }

  snapshot() { return { ...this.current } }
  status() { return this.run('status') }
  install() { return this.run('install') }
  repair() { return this.run('repair') }
  uninstall() { return this.run('uninstall') }

  async run(action) {
    if (!ACTIONS.has(action)) throw new Error('Unknown native input lifecycle action')
    const requestId = randomUUID()
    try {
      const result = await this.host.request({
        type: `lifecycle.${action}`,
        requestId,
      })
      if (
        result?.type !== 'lifecycle.result'
        || result.requestId !== requestId
        || result.action !== action
      ) {
        throw new Error('Native input lifecycle correlation mismatch')
      }
      this.current = normalizeLifecycleResult(result)
      return this.snapshot()
    } catch (error) {
      this.current = { ...this.current, state: 'error' }
      throw error
    }
  }
}

export function normalizeLifecycleResult(result = {}) {
  const installed = result.installed === true
  const registered = installed && result.registered === true
  const enabled = registered && result.enabled === true
  return {
    installed,
    registered,
    enabled,
    version: installed ? String(result.version || '') : '',
    state: !installed
      ? 'not-installed'
      : !registered ? 'needs-repair' : !enabled ? 'needs-enable' : 'ready',
  }
}
