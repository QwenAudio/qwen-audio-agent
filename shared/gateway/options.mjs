// The one translation from host-facing options to the environment the Gateway
// reads. The hosted process manager applies it to the child it forks; keeping
// a single mapping means a host's `backend: 'none'`
// cannot mean one thing in one launch shape and another elsewhere.
//
// Only options a caller actually passed are emitted, so an unset option leaves
// whatever the environment already decided — that is what keeps standalone
// entries env-driven.

/**
 * @param {object} options Host-facing Gateway options.
 * @returns {Record<string, string>} Environment entries for the given options.
 */
export function gatewayOptionsEnvironment({
  configDir,
  host,
  port,
  backend,
  owner,
  logConsole,
} = {}) {
  const env = {}
  if (configDir !== undefined) env.QWAUDIO_CONFIG_DIR = String(configDir)
  if (host !== undefined) env.HOST = String(host)
  if (port !== undefined) env.PORT = String(port)
  if (backend !== undefined) {
    env.AGENT_PROTOCOL = backend === 'none' || backend === null
      ? ''
      : String(backend)
  }
  if (owner !== undefined) env.QWEN_AUDIO_GATEWAY_OWNER = String(owner)
  if (logConsole !== undefined) {
    env.QWEN_AUDIO_LOG_CONSOLE = logConsole ? '1' : '0'
  }
  return env
}
