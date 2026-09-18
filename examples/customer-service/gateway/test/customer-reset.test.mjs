import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { startCustomerServiceGateway } from '../server.mjs'
import { startCustomerServiceServer } from '../../service/server.mjs'
import { CustomerService } from '../../service/service.mjs'
import { startServiceAgentServer } from '../../agent/server.mjs'
import { createClientServer } from '../../client/server.mjs'

test('真实 Gateway/A2A/MCP 挂起后换客户，旧任务、批准和核验清理，新对话为空', { timeout: 20_000 }, async t => {
  const service = new CustomerService()
  await service.execute('verify_identity', { email: 'liming3021@example.com' }, { surface: 'frontend' })
  const http = await startCustomerServiceServer({ service, port: 0 })
  const agent = await startServiceAgentServer({ port: 0, serviceOrigin: http.origin, model: {
    complete: async () => ({ tool_calls: [{ id: 'cancel', function: { name: 'cancel_order',
      arguments: JSON.stringify({ orderId: '#W1082334', reason: '不需要了' }) } }] }),
  } })
  const gateway = startCustomerServiceGateway({ port: 0, agentCardUrl: agent.agentCardUrl })
  await new Promise(resolve => gateway.server.once('listening', resolve))
  const gatewayOrigin = `http://127.0.0.1:${gateway.server.address().port}`
  const client = createClientServer({ gatewayOrigin, serviceOrigin: http.origin, agentOrigin: agent.origin })
  await new Promise(resolve => client.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    client.closeAllConnections()
    await new Promise(resolve => client.close(resolve))
    await gateway.close()
    await agent.close()
    await http.close()
  })
  const { identityManager, runtimeCommands, taskManager } = gateway.application.services
  const ownerId = identityManager.mode === 'personal' ? identityManager.personalIdentity.ownerId : `user_${randomUUID()}`
  const headers = { cookie: `${identityManager.cookieName}=${encodeURIComponent(`${ownerId}.${identityManager.sign(ownerId)}`)}`,
    'Content-Type': 'application/json' }
  const conversationId = `reset-test-${randomUUID()}`
  const pendingInput = new Promise(resolve => {
    const unsubscribe = taskManager.subscribe(event => {
      if (event.task.sessionId === conversationId && event.task.inputRequest?.status === 'pending') {
        unsubscribe()
        resolve(event.task)
      }
    })
    t.after(unsubscribe)
  })
  const task = runtimeCommands.createTask({ message: { parts: [{ type: 'text', text: '取消订单' }] } },
    { ownerId, sessionId: conversationId })
  await pendingInput
  assert.equal(agent.executor.suspended.size, 1)
  const token = [...agent.executor.suspended.values()][0].operation.token
  const response = await fetch(`http://127.0.0.1:${client.address().port}/api/customer-service/reset`, {
    method: 'POST', headers, body: JSON.stringify({ mode: 'new-customer', sessionId: 'default', conversationId }),
  })
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.notEqual(result.conversationId, conversationId)
  assert.equal(taskManager.get(task.id, { ownerId }).status, 'cancelled')
  assert.equal(agent.executor.suspended.size, 0)
  assert.equal(service.store.mutable('default').pendingApprovals?.has(token) || false, false)
  assert.equal(service.snapshot('default').identity.verified, false)
  assert.equal(service.snapshot('default').db.orders.find(o => o.orderId === '#W1082334').status, 'pending')
  const messages = await fetch(`${gatewayOrigin}/api/conversations/${result.conversationId}/messages`, { headers })
  assert.deepEqual((await messages.json()).messages, [])
})
