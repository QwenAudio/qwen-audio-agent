import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'

const reporter = '--test-reporter=tap'

function runFixture(t, source) {
  const directory = mkdtempSync(join(tmpdir(), 'qwa-ci-diagnostics-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const file = join(directory, 'fixture.test.mjs')
  writeFileSync(file, `import test from 'node:test'\n${source}\n`)
  const env = { ...process.env, NODE_OPTIONS: reporter }
  // This is a new test runner, not a child in this runner's internal protocol.
  delete env.NODE_TEST_CONTEXT
  const result = spawnSync(process.execPath, ['--test', file], {
    env, encoding: 'utf8', timeout: 10_000, windowsHide: true,
  })
  assert.ifError(result.error)
  assert.equal(result.signal, null, result.stderr)
  return result
}

test('Windows CI selects built-in TAP reporting without replacing the test command', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'))
  const step = workflow.jobs.test.steps.find(item => item.run === 'npm test')
  assert.ok(step)
  assert.equal(step.env.NODE_OPTIONS, `\${{ runner.os == 'Windows' && '${reporter}' || '' }}`)
  assert.notEqual(step['continue-on-error'], true)
})

test('CI reporting preserves a successful test run', t => {
  const result = runFixture(t, "test('passes', () => {})")
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /TAP version 13/)
  assert.match(result.stdout, /# fail 0/)
})

test('CI reporting exposes a test-file nonzero exit even after passing assertions', t => {
  const result = runFixture(t, "test('passes', () => {})\nprocess.exitCode = 42")
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stdout, /ok \d+ - passes/)
  assert.match(result.stdout, /failureType: 'testCodeFailure'/)
  assert.match(result.stdout, /exitCode: 42/)
  assert.match(result.stdout, /error: 'test failed'/)
})

test('CI reporting retains assertion failures and their diagnostics', t => {
  const result = runFixture(t, [
    "import assert from 'node:assert/strict'",
    "test('fails', () => assert.equal(1, 2))",
  ].join('\n'))
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stdout, /code: 'ERR_ASSERTION'/)
  assert.match(result.stdout, /expected: 2/)
  assert.match(result.stdout, /actual: 1/)
})

// Windows implements process.kill as forced termination, not a POSIX signal.
test('CI reporting exposes a test-file termination signal', {
  skip: process.platform === 'win32',
}, t => {
  const result = runFixture(t, "test('terminated', () => process.kill(process.pid, 'SIGTERM'))")
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stdout, /signal: 'SIGTERM'/)
})
