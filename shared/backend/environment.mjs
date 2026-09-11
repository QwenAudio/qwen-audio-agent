import { backendDefinition } from './catalog.mjs'

// Child Agents receive the operating-system context required to launch, plus
// only the credentials and product options declared by their backend plugin.
// Gateway, realtime, memory and other backend secrets are intentionally not
// inherited across this trust boundary.
const SYSTEM_NAMES = new Set([
  'APPDATA',
  'COLORTERM',
  'COMSPEC',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'LANG',
  'LOCALAPPDATA',
  'LOGNAME',
  'NODE_EXTRA_CA_CERTS',
  'NO_BROWSER',
  'NO_PROXY',
  'PATH',
  'PATHEXT',
  'PWD',
  'SHELL',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'USER',
  'USERDOMAIN',
  'USERNAME',
  'USERPROFILE',
  'WINDIR',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_RUNTIME_DIR',
  'XDG_STATE_HOME',
  'http_proxy',
  'https_proxy',
  'no_proxy',
])

const INTERNAL_NAMES = new Set([
  'QWEN_AUDIO_AGENT_BACKEND_AGENT',
  'QWEN_AUDIO_AGENT_BACKEND_MODEL',
  'QWEN_AUDIO_AGENT_BACKEND_OWNERSHIP',
  'QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE',
  'QWEN_AUDIO_AGENT_DESKTOP',
  'QWEN_AUDIO_AGENT_DESKTOP_INSTALLED_ONLY',
  'QWEN_AUDIO_AGENT_ENV_LOADED',
  'QWEN_AUDIO_AGENT_NODE',
  'QWEN_AUDIO_AGENT_ROOT',
  'QWEN_AUDIO_AGENT_RUNTIME_ROOT',
  'QWEN_AUDIO_AGENT_SOURCE_ROOT',
])

const SYSTEM_PREFIXES = ['LC_', 'npm_config_', 'NPM_CONFIG_']

function clean(value) {
  return String(value || '').trim()
}

function explicitNames(policy, env) {
  const name = clean(policy?.explicitListEnvironment)
  if (!name) return []
  return clean(env[name]).split(',').map(item => item.trim()).filter(Boolean)
}

function allowed(name, policy, explicit) {
  return SYSTEM_NAMES.has(name)
    || INTERNAL_NAMES.has(name)
    || SYSTEM_PREFIXES.some(prefix => name.startsWith(prefix))
    || policy.names?.includes(name)
    || policy.prefixes?.some(prefix => name.startsWith(prefix))
    || explicit.has(name)
}

export function backendEnvironment(protocol, {
  env = process.env,
  additions = {},
} = {}) {
  const definition = backendDefinition(protocol)
  if (!definition) throw new Error(`不支持的后台 Agent：${protocol}`)
  const policy = definition.environment || {}
  const explicit = new Set(explicitNames(policy, env))
  const projected = Object.fromEntries(
    Object.entries(env).filter(([name, value]) => (
      value !== undefined && allowed(name, policy, explicit)
    )),
  )
  return {
    ...projected,
    QWEN_AUDIO_AGENT_ENV_LOADED: '1',
    QWEN_AUDIO_AGENT_NODE: process.execPath,
    ...additions,
  }
}
