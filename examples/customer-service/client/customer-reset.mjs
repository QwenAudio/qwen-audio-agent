import { randomUUID } from 'node:crypto'

// 单通话 demo 的协调入口：先取消旧任务，再重置业务，最后切换对话 ID。
// 不删除历史文件，也不改变进程固定的 MCP 业务 sessionId。
export async function resetCustomer({ gatewayOrigin, serviceOrigin, agentOrigin,
  headers = {}, sessionId, conversationId, mode, fetchImpl = fetch }) {
  if (!['reset', 'new-customer'].includes(mode) || !conversationId) {
    throw new Error('Invalid customer reset request')
  }
  const call = async (origin, path, options = {}) => {
    const response = await fetchImpl(new URL(path, origin), {
      ...options, signal: AbortSignal.timeout(8_000),
    })
    if (!response.ok) throw new Error(`Customer cleanup failed (${response.status})`)
    return response.json()
  }
  const tasks = await call(gatewayOrigin,
    `/api/tasks?active=true&sessionId=${encodeURIComponent(conversationId)}`, { headers })
  if (!Array.isArray(tasks.tasks)) throw new Error('Invalid task cleanup response')
  for (const task of tasks.tasks) {
    await call(gatewayOrigin, `/api/tasks/${encodeURIComponent(task.id)}`, { method: 'DELETE', headers })
  }
  await call(agentOrigin, '/api/customer-service/reset', { method: 'POST' })
  const result = await call(serviceOrigin,
    `/api/service/${mode}?sessionId=${encodeURIComponent(sessionId)}`, { method: 'POST' })
  return { ...result, conversationRetained: false, conversationId: `customer-${randomUUID()}` }
}
