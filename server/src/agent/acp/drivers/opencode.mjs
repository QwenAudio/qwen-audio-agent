import { resolve } from 'node:path'
import { baseEnvironment, processAcpConnection } from './shared.mjs'

function clean(value) {
  return String(value || '').trim()
}

function optionValues(entries = []) {
  return entries.flatMap(entry => (
    Array.isArray(entry?.options)
      ? optionValues(entry.options)
      : [clean(entry?.value ?? entry?.id)]
  )).filter(Boolean)
}

function acceptsResumedSession({ session, role, coordinatorAgent }) {
  if (role !== 'coordinator' || clean(coordinatorAgent)) return true
  const options = Array.isArray(session?.response?.configOptions)
    ? session.response.configOptions
    : []
  const option = options.find(item => clean(item?.id) === 'mode')
  if (option?.type !== 'select') return true
  const current = clean(option.currentValue)
  const values = optionValues(option.options)
  return !(current && values.length && !values.includes(current))
}

export const openCodeBackendDriver = {
  id: 'opencode',
  label: 'OpenCode',
  capabilities: {
    delegation: true,
    permissions: true,
    backendUi: true,
    nativeSessionHistory: true,
    externalMcp: true,
    nativeDelegation: false,
    sessionMcp: true,
    coordinatorMcpInstructions: true,
  },

  createProfile({ root, directory }) {
    return {
      label: this.label,
      acpConnection: processAcpConnection({
        command: process.execPath,
        args: [resolve(root, 'scripts/opencode.mjs'), 'acp'],
        cwd: directory,
        env: { ...baseEnvironment('opencode'), ELECTRON_RUN_AS_NODE: '1' },
      }),
      externalMcp: true,
      nativeDelegation: false,
      backendUi: true,
      acceptResumedSession: acceptsResumedSession,
      uiUrl({ baseUrl, sessionId }) {
        if (!baseUrl || !sessionId) return baseUrl
        const serverKey = Buffer.from(baseUrl).toString('base64url')
        return `${
          baseUrl
        }/server/${serverKey}/session/${encodeURIComponent(sessionId)}`
      },
    }
  },

}
