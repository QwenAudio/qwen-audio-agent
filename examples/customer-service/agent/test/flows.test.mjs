import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { formatFlowPrompt, loadFlowsFrom } from '../flows.mjs'

function document(after, { enabled = true } = {}) {
  return {
    version: 1,
    domain: 'test',
    rules: [{
      id: 'identity-first',
      enabled,
      before: '完成身份核验',
      after,
      instruction: '不得跳步',
      policyLine: 14,
    }],
  }
}

test('启用的流程规则进入后台 Agent prompt，停用的不进入', () => {
  assert.match(formatFlowPrompt(document('办理业务')), /先「完成身份核验」，再「办理业务」/)
  assert.equal(formatFlowPrompt(document('办理业务', { enabled: false })), '')
})

test('flows 文件改写后下一次读取立即得到新流程', t => {
  const dir = mkdtempSync(join(tmpdir(), 'customer-service-flows-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'flows.json')
  writeFileSync(path, JSON.stringify(document('办理退货')))
  assert.match(formatFlowPrompt(loadFlowsFrom(path, 'test')), /办理退货/)
  writeFileSync(path, JSON.stringify(document('办理改签')))
  const prompt = formatFlowPrompt(loadFlowsFrom(path, 'test'))
  assert.match(prompt, /办理改签/)
  assert.doesNotMatch(prompt, /办理退货/)
})
