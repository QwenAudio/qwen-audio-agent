import { randomBytes } from 'node:crypto'
import {
  applyLocalAddress,
  localManagedBackend,
} from './shared.mjs'

export const openClawRuntimeDriver = {
  id: 'openclaw',
  separateManagedProcess: true,
  managedScript: 'openclaw-gateway.mjs',
  baseUrlEnvironment: 'OPENCLAW_BASE_URL',
  defaultBaseUrl: 'http://127.0.0.1:18789',
  supportsExternalService: true,

  resolve({ env, ownership, permissionMode }) {
    if (permissionMode === 'full') {
      throw new Error(
        'OpenClaw 的最高权限需要单独配置 exec approvals、elevated 和 host，'
        + '不能由 Gateway 的统一权限开关安全启用',
      )
    }
    return localManagedBackend({
      id: this.id,
      env,
      ownership,
      permissionMode,
      baseUrlEnvironment: this.baseUrlEnvironment,
      defaultBaseUrl: this.defaultBaseUrl,
      protocols: ['http:', 'https:', 'ws:', 'wss:'],
    })
  },

  applyAddress(env, backend) {
    applyLocalAddress(env, backend, {
      baseUrlEnvironment: this.baseUrlEnvironment,
      portEnvironment: 'OPENCLAW_PORT',
    })
  },

  prepareEnvironment(env, backend) {
    const managedCredential = (
      env.OPENCLAW_ORCAROUTER_API_KEY
      || (!env.DASHSCOPE_API_KEY && env.ORCAROUTER_API_KEY)
      || env.DASHSCOPE_API_KEY
      || ''
    )
    const managed = backend.ownership === 'owned'
      && !String(env.OPENCLAW_CONFIG_PATH || '').trim()
      && Boolean(String(managedCredential).trim())
      && Boolean(String(env.QWEN_AUDIO_AGENT_BACKEND_MODEL || '').trim())
      && String(env.QWEN_AUDIO_AGENT_BACKEND_MODEL).trim().toLowerCase() !== 'auto'
    if (managed && !String(env.OPENCLAW_GATEWAY_TOKEN || '').trim()) {
      // Gateway transport authentication is independent from the local user
      // identity signing secret and remains private to this backend plugin.
      env.OPENCLAW_GATEWAY_TOKEN = randomBytes(32).toString('hex')
    }
  },
}
