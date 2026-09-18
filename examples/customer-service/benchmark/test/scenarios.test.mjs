import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { TauScenarios } from '../tau-scenarios.mjs'
import { startCustomerServiceServer } from '../../service/server.mjs'
import { startServiceAgentServer } from '../../agent/server.mjs'
import { A2ABackendAdapter } from '../../../../server/src/backend/adapters/a2a/backend-adapter.mjs'

const root = process.env.CS_TAU2_ROOT
const python = process.env.CS_TAU2_PYTHON
const configured = Boolean(root && python)

test('测试 API 默认关闭；启用时必须绑定回环地址并提供令牌', async t => {
  const server = await startCustomerServiceServer({ port: 0, testMode: false })
  t.after(() => server.close())
  assert.equal((await fetch(`${server.origin}/api/test/scenarios/load`, { method: 'POST' })).status, 404)
  await assert.rejects(startCustomerServiceServer({ host: '0.0.0.0', testMode: true, testToken: 'test' }), /loopback/)
  await assert.rejects(startCustomerServiceServer({ testMode: true, testToken: '' }), /CS_TEST_TOKEN/)
})

test('非法注入参数在启动 Python 之前拒绝', async () => {
  const provider = new TauScenarios({ root: '/unused' })
  for (const input of [{ domain: 'unknown' }, { domain: 'retail', policy: '' },
    { domain: 'retail', database: [] }, { domain: 'airline', clock: 'now' },
    { domain: 'airline', taskId: 0 }]) {
    await assert.rejects(provider.load(input))
  }
  assert.equal(provider.worker, undefined)
  assert.throws(() => provider.context('tau-released'), /Unknown or released/)
})

test('写工具前台不可调用；令牌撤销和超时后不可提交', async () => {
  const provider = new TauScenarios({ root: '/unused' })
  provider.sessions.set('tau-test', { version: 'version', definitions: [
    { name: 'write', annotations: { readOnlyHint: false } },
  ] })
  const requests = []
  provider.request = async method => { requests.push(method); return { content: 'Preview', hash: 'hash' } }
  await assert.rejects(provider.execute('tau-test', 'write', {}, 'frontend'), /not available/)
  assert.deepEqual(requests, [])
  const first = await provider.execute('tau-test', 'write')
  assert.equal(provider.revoke('tau-other', first.data.approval.token), false)
  assert.equal(provider.revoke('tau-test', first.data.approval.token), true)
  await assert.rejects(provider.execute('tau-test', 'write', { approval_token: first.data.approval.token }), /Invalid/)
  const second = await provider.execute('tau-test', 'write')
  provider.approvals.get(second.data.approval.token).at -= 300_000
  await assert.rejects(provider.execute('tau-test', 'write', { approval_token: second.data.approval.token }), /Invalid/)
  assert.deepEqual(requests, ['preview', 'preview'])
  provider.close()
})

test('Python 无法启动时清理请求，关闭后不允许复活', async () => {
  const provider = new TauScenarios({ root: '/unused', python: '/missing-qwen-tau-python' })
  await assert.rejects(provider.load({ domain: 'retail' }), /ENOENT/)
  assert.equal(provider.pending.size, 0)
  assert.equal(provider.loading, 0)
  provider.close()
  await assert.rejects(provider.load({ domain: 'retail' }), /closed/)
})

test('身份仅由成功官方核验工具建立，跨会话隔离且拒绝换客户', async () => {
  const provider = new TauScenarios({ root: '/unused' })
  const definitions = [{ name: 'find_user_id_by_name_zip', annotations: { readOnlyHint: true } },
    { name: 'get_user_details', annotations: { readOnlyHint: true } }]
  provider.sessions.set('tau-first', { definitions })
  provider.sessions.set('tau-second', { definitions })
  let user = 'first'
  provider.request = async () => ({ content: user })
  await provider.execute('tau-first', 'get_user_details', { user_id: 'first' })
  assert.equal(provider.context('tau-first').verifiedIdentity, undefined)
  const args = { first_name: 'First', last_name: 'Last', zip: '12345' }
  await provider.execute('tau-first', 'find_user_id_by_name_zip', args, 'frontend')
  args.zip = 'changed'
  assert.equal(provider.context('tau-first').verifiedIdentity.arguments.zip, '12345')
  assert.equal(provider.context('tau-second').verifiedIdentity, undefined)
  user = 'second'
  await assert.rejects(provider.execute('tau-first', 'find_user_id_by_name_zip', args), /one authenticated customer/)
  assert.equal(provider.context('tau-first').verifiedIdentity.userId, 'first')
  provider.close()
})

test('官方零售场景：装载、隔离、预览、参数绑定、数据库注入与释放',
  { skip: !configured, timeout: 120_000 }, async t => {
    const provider = new TauScenarios({ root, python })
    t.after(() => provider.close())
    const first = await provider.load({ domain: 'retail', taskId: '0' })
    const second = await provider.load({ domain: 'retail', taskId: '0', policy: 'Injected policy' })
    assert.notEqual(first.sessionId, second.sessionId)
    assert.equal(provider.context(second.sessionId).policy, 'Injected policy')
    const names = provider.definitions(first.sessionId, 'backend').map(tool => tool.name)
    const verified = await provider.execute(first.sessionId, 'find_user_id_by_name_zip',
      { first_name: 'Yusuf', last_name: 'Rossi', zip: '19122' }, 'frontend')
    assert.equal(provider.context(first.sessionId).verifiedIdentity.userId, verified.content)
    assert.equal(provider.context(second.sessionId).verifiedIdentity, undefined)
    for (const name of ['exchange_delivered_order_items', 'modify_pending_order_items',
      'modify_pending_order_payment', 'modify_user_address']) assert.ok(names.includes(name))
    const action = first.task.evaluation_criteria.actions.find(a => a.name === 'exchange_delivered_order_items')
    const before = await provider.snapshot(first.sessionId)
    const preview = await provider.execute(first.sessionId, action.name, action.arguments)
    assert.equal(preview.data.needsApproval, true)
    assert.match(preview.content, /NOTHING HAS BEEN EXECUTED/)
    assert.doesNotMatch(preview.content, /"status"|"address1"|"fulfillments"/)
    assert.match(preview.content, /-16\.63/)
    assert.equal((await provider.snapshot(first.sessionId)).hash, before.hash)
    await assert.rejects(provider.execute(first.sessionId, action.name,
      { ...action.arguments, order_id: '#OTHER', approval_token: preview.data.approval.token }), /Mismatched/)
    assert.equal((await provider.snapshot(first.sessionId)).hash, before.hash)
    const approved = await provider.execute(first.sessionId, action.name, action.arguments)
    await assert.rejects(provider.execute(second.sessionId, action.name,
      { ...action.arguments, approval_token: approved.data.approval.token }), /Invalid tau approval/)
    const result = await provider.execute(first.sessionId, action.name,
      { ...action.arguments, approval_token: approved.data.approval.token })
    assert.ok(result.content)
    assert.equal(result.data.operationCommitted, true)
    const after = await provider.snapshot(first.sessionId)
    assert.equal(after.database.orders[action.arguments.order_id].status, 'exchange requested')
    assert.equal((await provider.snapshot(second.sessionId)).hash, before.hash)
    await assert.rejects(provider.execute(first.sessionId, action.name,
      { ...action.arguments, approval_token: approved.data.approval.token }), /Invalid tau approval/)
    const injected = await provider.load({ domain: 'retail', database: after.database })
    assert.equal((await provider.snapshot(injected.sessionId)).hash, after.hash)
    const scored = await provider.request('score', first.sessionId, {
      startTime: new Date().toISOString(), endTime: new Date().toISOString(),
      duration: 0, terminationReason: 'user_stop',
    })
    assert.equal(scored.replayMatchesLive, true, '评分轨迹必须准确复现真实数据库')
    assert.equal(scored.reward.db_check.db_match, true)
    assert.equal(scored.reward.reward, 1)
    await provider.release(first.sessionId)
    await assert.rejects(provider.execute(first.sessionId, action.name, action.arguments), /Unknown or released/)
  })

test('官方航空场景：全部工具与固定原始时钟；拒绝陈旧数据库预览',
  { skip: !configured, timeout: 120_000 }, async t => {
    const provider = new TauScenarios({ root, python })
    t.after(() => provider.close())
    const loaded = await provider.load({ domain: 'airline', taskId: '8' })
    const names = provider.definitions(loaded.sessionId, 'backend').map(tool => tool.name)
    for (const name of ['book_reservation', 'update_reservation_passengers', 'search_onestop_flight']) {
      assert.ok(names.includes(name))
    }
    const writes = loaded.task.evaluation_criteria.actions.filter(a =>
      !provider.definitions(loaded.sessionId, 'backend').find(tool => tool.name === a.name)?.annotations.readOnlyHint)
    assert.ok(writes.length)
    const action = writes[0]
    const before = await provider.snapshot(loaded.sessionId)
    const previews = await Promise.all([1, 2].map(() => provider.execute(loaded.sessionId, action.name, action.arguments)))
    assert.equal((await provider.snapshot(loaded.sessionId)).hash, before.hash)
    await provider.execute(loaded.sessionId, action.name,
      { ...action.arguments, approval_token: previews[0].data.approval.token })
    const after = await provider.snapshot(loaded.sessionId)
    assert.notEqual(after.hash, before.hash)
    await assert.rejects(provider.execute(loaded.sessionId, action.name,
      { ...action.arguments, approval_token: previews[1].data.approval.token }), /Database changed/)
    assert.equal((await provider.snapshot(loaded.sessionId)).hash, after.hash)
  })

test('Realtime 单独组使用官方工具错误消息语义并记录失败调用，DB 不变',
  { skip: !configured, timeout: 120_000 }, async t => {
    const provider = new TauScenarios({ root, python })
    t.after(() => provider.close())
    const loaded = await provider.load({ domain: 'retail', taskId: '0' })
    const before = await provider.snapshot(loaded.sessionId)
    const result = await provider.request('raw-call', loaded.sessionId, {
      name: 'get_order_details', args: { order_id: '#UNKNOWN' },
    })
    assert.equal(result.error, true)
    assert.match(result.content, /Error:/)
    assert.equal((await provider.snapshot(loaded.sessionId)).hash, before.hash)
    const scored = await provider.request('score', loaded.sessionId, {
      startTime: new Date().toISOString(), endTime: new Date().toISOString(),
      duration: 0, terminationReason: 'max_steps',
    })
    assert.equal(scored.replayMatchesLive, true)
    assert.equal(scored.messages.at(-1).error, true)
    assert.equal(scored.messages.at(-2).tool_calls[0].name, 'get_order_details')
  })

for (const domain of ['retail', 'airline']) for (const action of ['accept', 'decline']) {
  test(`注入官方 ${domain} policy 和工具后，真实 HTTP/MCP/A2A：${action}`,
    { skip: !configured, timeout: 120_000 }, async t => {
      const server = await startCustomerServiceServer({ port: 0, testMode: true,
        testToken: 'test-secret', tauRoot: root, tauPython: python })
      const endpoint = `${server.origin}/api/test/scenarios/load`
      assert.equal((await fetch(endpoint, { method: 'POST' })).status, 403)
      assert.equal((await fetch(endpoint, { method: 'POST',
        headers: { Authorization: 'Bearer test-secret', Origin: 'http://other' } })).status, 403)
      const response = await fetch(endpoint, { method: 'POST',
        headers: { Authorization: 'Bearer test-secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain, taskId: domain === 'retail' ? '0' : '8',
          policy: readFileSync(`${root}/data/tau2/domains/${domain}/policy.md`, 'utf8') }) })
      assert.equal(response.status, 200)
      const loaded = await response.json()
      const actions = loaded.task.evaluation_criteria.actions
      const context = await (await fetch(`${server.origin}/api/service/context?sessionId=${loaded.sessionId}`)).json()
      let index = 0
      const agent = await startServiceAgentServer({ port: 0, serviceOrigin: server.origin,
        sessionId: loaded.sessionId, model: { complete: async ({ messages, tools }) => {
          assert.ok(messages[0].content.startsWith(context.policy))
          assert.doesNotMatch(messages[0].content, /明远|超过 2000/)
          assert.ok(tools.some(tool => tool.function.name ===
            (domain === 'retail' ? 'exchange_delivered_order_items' : 'book_reservation')))
          const call = actions[index++]
          return call ? { tool_calls: [{ id: `call-${index}`, function: {
            name: call.name, arguments: JSON.stringify(call.arguments),
          } }] } : { content: 'Done' }
        } } })
      const backend = new A2ABackendAdapter({ agentCardUrl: agent.agentCardUrl, pollIntervalMs: 10 })
      t.after(async () => { await backend.close(); await agent.close(); await server.close() })
      const waiting = Promise.withResolvers()
      const unsubscribe = backend.subscribe(event => {
        if (event.input?.status === 'pending') waiting.resolve(event.input)
      })
      t.after(unsubscribe)
      const before = await server.service.scenarios.snapshot(loaded.sessionId)
      const running = backend.submit({ id: 'exchange', ownerId: 'owner', objective: 'Exchange my items' })
      const input = await waiting.promise
      assert.equal(input.kind, 'authorization')
      assert.doesNotMatch(input.prompt, /approval_token|token-/)
      await backend.respondInput('exchange', input.id, { action })
      await running
      const after = await server.service.scenarios.snapshot(loaded.sessionId)
      const snapshotResponse = await fetch(`${server.origin}/api/test/scenarios/snapshot?sessionId=${loaded.sessionId}`,
        { headers: { Authorization: 'Bearer test-secret' } })
      assert.equal(snapshotResponse.status, 200)
      assert.equal((await snapshotResponse.json()).hash, after.hash)
      if (domain === 'retail') assert.equal(after.database.orders['#W2378156'].status,
        action === 'accept' ? 'exchange requested' : before.database.orders['#W2378156'].status)
      else if (action === 'accept') assert.equal(Object.keys(after.database.reservations).length,
        Object.keys(before.database.reservations).length + 1)
      if (action === 'decline') assert.equal(after.hash, before.hash)
    })
}

test('真实 HTTP/MCP/A2A 补充输入恢复同一任务，原核验可用且信息答复不提交写库',
  { skip: !configured, timeout: 120_000 }, async t => {
    const server = await startCustomerServiceServer({ port: 0, testMode: true,
      testToken: 'test-secret', tauRoot: root, tauPython: python })
    t.after(() => server.close())
    const scenarios = server.service.scenarios
    const loaded = await scenarios.load({ domain: 'retail', taskId: '0' })
    await scenarios.execute(loaded.sessionId, 'find_user_id_by_name_zip',
      { first_name: 'Yusuf', last_name: 'Rossi', zip: '19122' }, 'frontend')
    const context = await (await fetch(`${server.origin}/api/service/context?sessionId=${loaded.sessionId}`)).json()
    assert.equal(context.verifiedIdentity.userId, 'yusuf_rossi_9620')
    assert.equal(context.task, undefined, '后台上下文不能携带隐藏任务')
    const operation = loaded.task.evaluation_criteria.actions.find(a => a.name === 'exchange_delivered_order_items')
    let calls = 0
    const agent = await startServiceAgentServer({ port: 0, serviceOrigin: server.origin,
      sessionId: loaded.sessionId, model: { complete: async ({ messages }) => {
        calls += 1
        assert.match(messages[0].content, /ALREADY been authenticated/)
        if (calls === 1) return { tool_calls: [{ id: 'ask', function: {
          name: 'ask_customer', arguments: '{"question":"Original card or gift card?"}' } }] }
        assert.match(messages.at(-1).content, /original card/)
        return { tool_calls: [{ id: 'write', function: {
          name: operation.name, arguments: JSON.stringify(operation.arguments) } }] }
      } } })
    t.after(() => agent.close())
    const backend = new A2ABackendAdapter({ agentCardUrl: agent.agentCardUrl, pollIntervalMs: 10 })
    t.after(() => backend.close())
    const info = Promise.withResolvers(), approval = Promise.withResolvers()
    const unsubscribe = backend.subscribe(event => {
      if (event.input?.status === 'pending') {
        if (event.input.kind === 'authorization') approval.resolve(event.input)
        else info.resolve(event.input)
      }
    })
    t.after(unsubscribe)
    const before = await scenarios.snapshot(loaded.sessionId)
    const running = backend.submit({ id: 'same-task', ownerId: 'owner', objective: 'Exchange my items' })
    running.catch(() => {})
    const input = await info.promise
    await backend.respondInput('same-task', input.id, { action: 'accept', text: 'original card, yes' })
    const confirm = await approval.promise
    assert.notEqual(confirm.id, input.id)
    assert.equal((await scenarios.snapshot(loaded.sessionId)).hash, before.hash)
    assert.equal(calls, 2)
    await backend.respondInput('same-task', confirm.id, { action: 'decline' })
    await running
    assert.equal((await scenarios.snapshot(loaded.sessionId)).hash, before.hash)
  })
