import {
  applyLocalAddress,
  localManagedBackend,
} from './shared.mjs'

function inlineConfig(value) {
  if (!String(value || '').trim()) return {}
  let parsed
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('OPENCODE_CONFIG_CONTENT 不是有效的 JSON')
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('OPENCODE_CONFIG_CONTENT 必须是 JSON 对象')
  }
  return parsed
}

function configuredAgent(env) {
  const selected = String(
    env.QWEN_AUDIO_AGENT_BACKEND_AGENT
    || env.OPENCODE_COORDINATOR_AGENT
    || '',
  ).trim()
  return [
    'qwen-audio-agent-backend',
    'qwen-audio-agent-coordinator',
  ].includes(selected) ? '' : selected
}

export const openCodeRuntimeDriver = {
  id: 'opencode',
  separateManagedProcess: true,
  managedScript: 'opencode-server.mjs',
  managedNpmScript: 'opencode',

  resolve({ env, ownership, permissionMode }) {
    return localManagedBackend({
      id: this.id,
      env,
      ownership,
      permissionMode,
      baseUrlEnvironment: 'OPENCODE_BASE_URL',
      defaultBaseUrl: 'http://127.0.0.1:4096',
    })
  },

  applyPermissionMode(env, backend) {
    if (backend.permissionMode !== 'full') return env
    const config = inlineConfig(env.OPENCODE_CONFIG_CONTENT)
    const agents = {
      ...(config.agent && typeof config.agent === 'object'
        ? config.agent
        : {}),
    }
    const names = new Set([
      configuredAgent(env),
      String(env.OPENCODE_TASK_AGENT || 'build').trim(),
    ])
    for (const name of names) {
      if (!name) continue
      const existing = agents[name]
      agents[name] = {
        ...(existing && typeof existing === 'object' ? existing : {}),
        permission: 'allow',
      }
    }
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      ...config,
      permission: 'allow',
      agent: agents,
    })
    return env
  },

  applyAddress(env, backend) {
    applyLocalAddress(env, backend, {
      baseUrlEnvironment: 'OPENCODE_BASE_URL',
      portEnvironment: 'OPENCODE_PORT',
    })
  },
}
