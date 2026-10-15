import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

const execute = promisify(execFile)
const script = fileURLToPath(new URL('../../scripts/test/acp-parallel-live.mjs', import.meta.url))

test('parallel live check requires opt-in and rejects unknown backends before launching any CLI', async () => {
  for (const args of [[], ['qwen'], ['opencode'], ['qoder'], ['unknown-backend', '--run'], ['qwen', '--run', '--extra']]) {
    await assert.rejects(execute(process.execPath, [script, ...args], { timeout: 5_000 }), error => {
      assert.equal(error.code, 1, JSON.stringify({ args, signal: error.signal, stderr: error.stderr }))
      assert.match(error.stderr, /Explicit opt-in required/)
      return true
    })
  }
})

test('parallel live check help documents its safety and cost boundary without starting an Agent', async () => {
  const { stdout } = await execute(process.execPath, [script, '--help'], { timeout: 5_000 })
  assert.match(stdout, /qwen\|opencode\|qoder/)
  assert.match(stdout, /Three short text calls, 60s timeout, tools denied, temporary workspace/)
  assert.match(stdout, /no user configuration changes/)
})
