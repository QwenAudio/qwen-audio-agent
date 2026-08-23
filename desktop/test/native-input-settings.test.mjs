import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

async function runSettingsProbe() {
  const executable = resolve(
    root,
    'node_modules/.bin',
    process.platform === 'win32' ? 'electron.cmd' : 'electron',
  )
  const fixture = resolve(
    root,
    'desktop/smoke/native-input-settings-smoke.cjs',
  )
  const child = spawn(executable, [fixture], {
    cwd: root,
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000)
  const [code, signal] = await new Promise(resolveExit => {
    child.once('error', error => {
      stderr += error.stack || error.message
      resolveExit([1, null])
    })
    child.once('exit', (...result) => resolveExit(result))
  })
  clearTimeout(timer)
  assert.equal(
    code,
    0,
    `Native input settings probe failed (${signal || code})\n${stdout}\n${stderr}`,
  )
  const line = stdout.split('\n').find(value => (
    value.startsWith('NATIVE_INPUT_SETTINGS_PROBE:')
  ))
  assert.ok(line, `Native input settings probe returned no result\n${stdout}`)
  return JSON.parse(line.slice('NATIVE_INPUT_SETTINGS_PROBE:'.length))
}

const probe = process.platform === 'darwin' ? await runSettingsProbe() : null

test('needs-enable offers an explicit input source settings action', {
  skip: process.platform !== 'darwin',
}, () => {
  assert.deepEqual({
    status: probe.status,
    buttonText: probe.buttonText,
    buttonVisible: probe.buttonVisible,
    openSettingsRequests: probe.openSettingsRequests,
  }, {
    status: 'Installed. Enable Qwen Input in System Settings.',
    buttonText: 'Open Input Source Settings',
    buttonVisible: true,
    openSettingsRequests: 1,
  })
})

test('returning from input source settings refreshes lifecycle state', {
  skip: process.platform !== 'darwin',
}, () => {
  assert.ok(probe.callsAfterFocus > probe.callsBeforeFocus)
  assert.equal(probe.refreshedStatus, 'Installed and enabled')
})
