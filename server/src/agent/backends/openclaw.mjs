import { dirname, resolve } from 'node:path'
import { OpenClawAcpDelegationAdapter } from '../openclaw-adapter.mjs'
import { writePrivateFile } from './private-file.mjs'
import {
  baseEnvironment,
  clean,
  processAcpConnection,
  websocketUrl,
} from './shared.mjs'

function sanitizeProcessOutput(value) {
  return String(value || '')
    .split(/\r?\n/)
    .filter(line => !line.includes('🦞 [openclaw-bundle]'))
    .join('\n')
    .trim()
}

function formatRequestError({ details }) {
  const missingScope = details.match(
    /\bmissing scope:\s*([a-z0-9._-]+)/i,
  )?.[1]
  return missingScope
    ? `需要在 OpenClaw 中批准 ACP 设备权限（缺少 ${missingScope}）`
    : ''
}

function promptRetryDelay({ error, attempt }) {
  const diagnostic = `${error?.message || ''}\n${error?.body || ''}`
  if (
    !/reply session initialization conflicted for \S+/i.test(diagnostic)
  ) return null
  return [150, 500, 1000, 2000, 3000][attempt] ?? null
}

export const openClawBackendDriver = {
  id: 'openclaw',
  label: 'OpenClaw',
  capabilities: {
    delegation: true,
    permissions: true,
    backendUi: true,
    nativeSessionHistory: true,
    externalMcp: false,
    nativeDelegation: true,
    sessionMcp: false,
    coordinatorMcpInstructions: false,
  },

  createProfile({
    root,
    ownership,
    directory,
    cliPath,
    baseUrl,
    token,
    tokenFile,
    coordinatorAgent,
  }) {
    const directBridge = clean(cliPath)
    const bridgeTokenFile = clean(tokenFile)
    const bridgeArgs = [
      'acp',
      '--url',
      websocketUrl(baseUrl),
      ...(bridgeTokenFile
        ? ['--token-file', bridgeTokenFile]
        : []),
      '--verbose',
    ]
    return {
      label: this.label,
      acpConnection: processAcpConnection({
        command: directBridge || process.execPath,
        args: directBridge
          ? bridgeArgs
          : [resolve(root, 'scripts/openclaw.mjs'), ...bridgeArgs],
        cwd: directory,
        env: {
          ...baseEnvironment('openclaw'),
          ELECTRON_RUN_AS_NODE: '1',
          ...(token ? { OPENCLAW_GATEWAY_TOKEN: token } : {}),
          // Keep the ACP bridge's device identity separate from the user's
          // normal OpenClaw CLI identity. A loopback bridge presenting the
          // Gateway's shared token can then use OpenClaw's silent local pairing
          // instead of inheriting a stale, narrowly scoped user device token.
          ...(clean(tokenFile)
            ? { OPENCLAW_STATE_DIR: dirname(clean(tokenFile)) }
            : {}),
        },
        prepare: directBridge && clean(token) && bridgeTokenFile
          ? () => writePrivateFile(bridgeTokenFile, `${clean(token)}\n`)
          : undefined,
      }),
      externalMcp: false,
      sessionMcp: false,
      nativeDelegation: true,
      // Owned instances are provisioned before ACP starts. External instances
      // must advertise the standard ACP model option for Session overrides.
      sessionModelConfiguration: ownership !== 'owned',
      backendUi: true,
      sanitizeProcessOutput,
      formatRequestError,
      promptRetryDelay,
      // An owned Gateway is started concurrently and may need a short warm-up.
      // For an external Gateway, let the official bridge establish the real
      // connection so TLS, authentication, routing, and remote-network errors
      // are reported accurately instead of being hidden by a local TCP probe.
      readinessMessage: ownership === 'external'
        ? ''
        : 'OpenClaw Gateway 正在启动',
      coordinatorMeta(ownerId) {
        if (!clean(coordinatorAgent)) return null
        const owner = encodeURIComponent(
          clean(ownerId) || 'personal',
        ).toLowerCase()
        return {
          sessionKey: `agent:${
            clean(coordinatorAgent)
          }:qwen-audio-agent:${owner}:backend`,
        }
      },
      defaultDelegationTitle: 'OpenClaw 项目任务',
      sessionInstructions: [
        'When the current request explicitly requires a new or previous',
        'project Session, use OpenClaw native Session tools:',
        'sessions_spawn to create work, sessions_list to locate prior Sessions,',
        'sessions_send to continue one, and sessions_history for status.',
      ].join(' '),
      uiUrl({ baseUrl }) {
        if (!baseUrl) return null
        const dashboard = new URL(baseUrl)
        const gateway = new URL(baseUrl)
        gateway.protocol = gateway.protocol === 'https:' ? 'wss:' : 'ws:'
        gateway.pathname = '/'
        gateway.search = ''
        gateway.hash = ''
        const settings = new URLSearchParams({
          gatewayUrl: gateway.toString(),
        })
        if (token) settings.set('token', token)
        dashboard.pathname = '/'
        dashboard.search = ''
        dashboard.hash = settings.toString()
        return dashboard.toString()
      },
    }
  },

  createNativeDelegationAdapter({ baseUrl, token, tokenFile }) {
    return new OpenClawAcpDelegationAdapter({ baseUrl, token, tokenFile })
  },

}
