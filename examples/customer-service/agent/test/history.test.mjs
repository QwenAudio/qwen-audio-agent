import assert from 'node:assert/strict'
import test from 'node:test'
import { ServiceAgentExecutor } from '../executor.mjs'

function request(taskId, text, contextId = 'customer-one', task) {
  return { taskId, contextId, task, userMessage: { parts: [{ content: { $case: 'text', value: text } }] } }
}

function fixture({ complete, tools: extra = {} } = {}) {
  const seen = []
  const events = []
  const executor = new ServiceAgentExecutor({
    tools: { list: async () => [], call() {}, ...extra },
    model: { async complete(input) {
      seen.push(structuredClone(input.messages))
      return complete ? complete(input) : { content: `reply: ${input.messages.at(-1).content}` }
    } },
  })
  return { executor, seen, events, run: (...args) => executor.execute(request(...args), {
    publish(event) { events.push(event) },
  }) }
}

test('customer-service keeps completed turns, isolates contexts and limits history to 50 turns', async () => {
  const h = fixture()
  await h.run('first', '查询退货条件')
  await h.run('second', '那刚才那笔订单呢')
  assert.deepEqual(h.seen[1].slice(1, -1), [
    { role: 'user', content: '查询退货条件' },
    { role: 'assistant', content: 'reply: 查询退货条件' },
  ])
  await h.run('other', 'another customer', 'customer-two')
  assert.equal(h.seen[2].length, 2)
  for (let i = 0; i < 55; i++) await h.run(`turn-${i}`, `request-${i}`)
  assert.equal(h.seen.at(-1).length, 100)
  assert.equal(h.seen.at(-1)[1].content, 'request-5')
})

function approvalFixture() {
  return fixture({
    tools: {
      list: async () => [{ name: 'modify_order' }],
      call: async (_name, args) => args.approval_token
        ? { content: '订单已修改', data: {} }
        : { content: '请确认修改订单 approval_token="private-token"', data: { needsApproval: true } },
    },
    complete: async ({ messages }) => {
      const last = messages.at(-1)
      if (last.role === 'tool') return { content: last.content }
      const token = last.content.match(/approval_token="([^"]+)"/)?.[1]
      if (last.content !== '修改订单' && !token) return { content: '查询完成' }
      return { tool_calls: [{ id: 'call-1', function: {
        name: 'modify_order', arguments: JSON.stringify(token ? { approval_token: token } : {}),
      } }] }
    },
  })
}

test('pending approvals resume by Task ID, not shared context, and are not archived as reusable authority', async () => {
  const h = approvalFixture()
  await h.run('pending', '修改订单')
  assert.equal(h.executor.suspended.size, 1)
  await h.run('different-task', '先查询另一笔订单')
  assert.doesNotMatch(JSON.stringify(h.seen.at(-1)), /private-token/)
  assert.equal(h.executor.suspended.size, 1)
  await h.run('pending', '同意', 'customer-one', {})
  assert.equal(h.executor.suspended.size, 0)
  await h.run('follow-up', '刚才处理得怎么样')
  const messages = h.seen.at(-1)
  assert.match(JSON.stringify(messages), /订单已修改/)
  assert.match(JSON.stringify(messages), /客户补充：同意/)
  assert.doesNotMatch(JSON.stringify(messages), /private-token|tool_call_id/)
})

test('cancel clears suspended task and records cancellation without the approval token', async () => {
  const h = approvalFixture()
  await h.run('pending', '修改订单')
  await h.executor.cancelTask('pending')
  assert.equal(h.executor.suspended.size, 0)
  await h.run('next', '查询订单')
  assert.match(JSON.stringify(h.seen.at(-1)), /取消了待确认任务/)
  assert.doesNotMatch(JSON.stringify(h.seen.at(-1)), /private-token/)
})

test('new customer clears history; an old in-flight response cannot contaminate the new customer', async () => {
  let conversationId = 'customer-a'
  const blocked = Promise.withResolvers()
  const started = Promise.withResolvers()
  const h = fixture({
    tools: { conversationId: async () => conversationId },
    complete: async ({ messages }) => {
      if (messages.at(-1).content === 'old-in-flight') {
        started.resolve()
        await blocked.promise
      }
      return { content: messages.at(-1).content }
    },
  })
  await h.run('first', 'old customer secret')
  const running = h.run('old', 'old-in-flight')
  await started.promise
  conversationId = 'customer-b'
  await h.run('new', 'new customer')
  assert.equal(h.seen.at(-1).length, 2)
  blocked.resolve()
  await running
  await h.run('follow', 'continue')
  assert.doesNotMatch(JSON.stringify(h.seen.at(-1)), /old customer|old-in-flight/)
})

test('failed context lookup does not use previous customer history and still emits Task before failure', async () => {
  const h = fixture({ tools: { conversationId: async () => { throw new Error('offline') } } })
  await h.run('task', 'request')
  assert.equal(h.seen.length, 0)
  assert.equal(h.events[0].kind, 'task')
  assert.match(h.events.at(-1).data.status.message.parts[0].content.value, /offline/)
})
