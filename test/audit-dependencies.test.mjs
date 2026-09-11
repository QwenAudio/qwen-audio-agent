import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const directory = mkdtempSync(join(tmpdir(), 'qwa-audit-test-'))
const mockNpm = join(directory, 'mock-npm.mjs')

writeFileSync(mockNpm, `
const mode = process.env.MOCK_NPM_AUDIT
if (mode === 'unavailable') {
  console.log(JSON.stringify({ message: '503 Service Unavailable', error: { summary: '' } }))
  process.exit(1)
}
const high = mode === 'vulnerable' ? 1 : 0
console.log(JSON.stringify({
  auditReportVersion: 2,
  vulnerabilities: high ? { example: { severity: 'high', via: [] } } : {},
  metadata: { vulnerabilities: { high, critical: 0 } },
}))
process.exit(high ? 1 : 0)
`)

function audit(mode, extraEnv = {}) {
  return spawnSync(process.execPath, ['scripts/audit-dependencies.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      npm_execpath: mockNpm,
      MOCK_NPM_AUDIT: mode,
      ...extraEnv,
    },
  })
}

test('dependency audit passes only a valid clean report', () => {
  const result = audit('clean')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /依赖审计通过/)
})

test('dependency audit never treats a real high vulnerability as an outage', () => {
  const result = audit('vulnerable', {
    QWEN_AUDIO_AGENT_AUDIT_ALLOW_UNAVAILABLE: '1',
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /生产依赖存在 high 或 critical 漏洞/)
})

test('non-release CI can continue when the audit service is unavailable', () => {
  const result = audit('unavailable', {
    QWEN_AUDIO_AGENT_AUDIT_ALLOW_UNAVAILABLE: '1',
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /审计服务不可用；非发版检查继续/)
  assert.match(result.stderr, /正在重试/)
})
