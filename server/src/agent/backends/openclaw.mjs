import { dirname, resolve } from 'node:path'
import { OpenClawAcpDelegationAdapter } from '../openclaw-adapter.mjs'
import { baseEnvironment, clean, websocketUrl } from './shared.mjs'

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
  return [150, 500, 1000][attempt] ?? null
}

export const openClawBackendDriver = {
  id: 'openclaw',
  label: 'OpenClaw',

  createProfile({
    root,
    directory,
    baseUrl,
    token,
    tokenFile,
    coordinatorAgent,
  }) {
    return {
      label: this.label,
      command: process.execPath,
      args: [
        resolve(root, 'scripts/openclaw.mjs'),
        'acp',
        '--url',
        websocketUrl(baseUrl),
        ...(clean(tokenFile)
          ? ['--token-file', clean(tokenFile)]
          : []),
        '--verbose',
      ],
      cwd: directory,
      env: {
        ...baseEnvironment(),
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
      externalMcp: false,
      nativeDelegation: true,
      backendUi: true,
      sanitizeProcessOutput,
      formatRequestError,
      promptRetryDelay,
      readinessMessage: 'OpenClaw Gateway 正在启动',
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
        'For a separate or previous project, use OpenClaw native session tools:',
        'sessions_spawn to create work, sessions_list to locate prior Sessions,',
        'sessions_send to continue one, and sessions_history for status.',
        'These are third-layer tasks. After spawn/send is accepted, return the',
        'delegated response required by the request envelope and stop this turn.',
      ].join(' '),
      cancelInstruction(record) {
        return `请用 OpenClaw 原生 Session 工具立即停止 sessionKey=${
          record.sessionId
        } 对应的第三层任务。`
      },
      statusInstruction(record) {
        return `请调用 OpenClaw 原生 sessions_history 查询 sessionKey=${
          record.sessionId
        } 的真实状态和阶段结果。`
      },
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
