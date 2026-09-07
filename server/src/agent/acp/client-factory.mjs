import { AgentError } from '../agent-error.mjs'
import { AcpProcessClient } from './process-client.mjs'

export const ACP_CONNECTION_PROCESS = 'process'

export function createAcpClient({ connection, ...options }) {
  const kind = String(connection?.kind || '').trim().toLowerCase()
  if (kind === ACP_CONNECTION_PROCESS) {
    return new AcpProcessClient({
      ...options,
      command: connection.command,
      args: connection.args,
      cwd: connection.cwd,
      env: connection.env,
      prepare: connection.prepare,
    })
  }
  throw new AgentError(
    `不支持的 ACP 连接方式：${kind || '未配置'}`,
    { protocol: 'acp' },
  )
}
