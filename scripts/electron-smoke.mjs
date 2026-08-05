import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const executable = resolve(
  root,
  'node_modules/.bin',
  process.platform === 'win32' ? 'electron.cmd' : 'electron',
)
const fixture = resolve(root, 'desktop/smoke/electron-smoke.cjs')

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
const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
const [code, signal] = await new Promise(resolvePromise => {
  child.once('error', error => {
    stderr += error.stack || error.message
    resolvePromise([1, null])
  })
  child.once('exit', (...result) => resolvePromise(result))
})
clearTimeout(timer)
if (code !== 0 || !stdout.includes('QWEN_AUDIO_DESKTOP_SMOKE_OK')) {
  throw new Error(
    `Electron desktop smoke test failed (${signal || code})\n${stdout}\n${stderr}`,
  )
}
process.stdout.write('Electron desktop smoke test passed.\n')
