import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CustomerServiceAnnouncementManager,
} from '../customer-service-announcement-runtime.mjs'

async function waitFor(condition, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for delivery')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

test('客服写操作只把运行时回执投影给前台', async () => {
  const inputs = []
  const manager = new CustomerServiceAnnouncementManager({
    getFrontend: () => ({
      ready: true,
      injectResult: async text => {
        inputs.push(text)
        return { completed: true, contextInjected: true }
      },
    }),
    batchWindowMs: 0,
  })
  manager.completed({
    id: 'refund-task',
    objective: '取消并退款',
    result: '退款已经到账，稍后还会发送确认邮件。',
    artifacts: [{
      artifactId: 'customer-service-execution-receipt',
      parts: [{ data: {
        schema: 'qwen-audio-agent/customer-service-execution-receipt@1',
        outcome: 'committed',
        committedCount: 1,
        committedOperations: [{
          operation: 'process_refund', status: 'committed',
          result: { refund_id: 'REF-1', message: 'Refund initiated' },
        }],
      } }],
    }],
  })
  await waitFor(() => inputs.length === 1)
  assert.match(inputs[0], /customer_service_execution_receipt/)
  assert.match(inputs[0], /"refund_id":"REF-1"/)
  assert.doesNotMatch(inputs[0], /退款已经到账/)
  assert.doesNotMatch(inputs[0], /确认邮件/)
  assert.doesNotMatch(inputs[0], /取消并退款/)
  manager.close()
})

test('客服只读结果仍保留后台自然语言结果', async () => {
  const inputs = []
  const manager = new CustomerServiceAnnouncementManager({
    getFrontend: () => ({
      ready: true,
      injectResult: async text => {
        inputs.push(text)
        return { completed: true, contextInjected: true }
      },
    }),
    batchWindowMs: 0,
  })
  manager.completed({
    id: 'flight-options',
    objective: '查询可选航班',
    result: '找到两个符合时间要求的航班。',
    artifacts: [{
      artifactId: 'customer-service-execution-receipt',
      parts: [{ data: {
        schema: 'qwen-audio-agent/customer-service-execution-receipt@1',
        outcome: 'no_change', committedCount: 0, committedOperations: [],
      } }],
    }],
  })
  await waitFor(() => inputs.length === 1)
  assert.match(inputs[0], /查询可选航班/)
  assert.match(inputs[0], /找到两个符合时间要求的航班/)
  manager.close()
})
