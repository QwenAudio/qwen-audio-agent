// Exercise the shipped ASAR and Electron, not the source checkout. No real
// frontend/backend service, user configuration or signing credentials are used.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { extractFile, listPackage } from '@electron/asar'

const root = fileURLToPath(new URL('../../', import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), 'qwa-desktop-package-'))
const outputDirectory = join(scratch, 'output')
const configDirectory = join(scratch, 'config')
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => (
  ['path', 'systemroot', 'comspec', 'pathext', 'temp', 'tmp', 'tmpdir', 'lang'].includes(key.toLowerCase())
)))

function run(command, args, { env = environment, timeout = 180_000 } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolveRun(output.trim())
      else reject(new Error(`Packaged desktop command failed (${signal || code}):\n${output}`))
    })
  })
}

async function checkGateway(executable, archive) {
  const child = spawn(executable, [join(archive, 'server/src/index.mjs')], {
    cwd: scratch,
    env: {
      ...environment,
      ELECTRON_RUN_AS_NODE: '1',
      QWAUDIO_CONFIG_DIR: configDirectory,
      DASHSCOPE_API_KEY: 'sk-packaged-smoke-placeholder',
      AGENT_PROTOCOL: 'none',
      PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let logs = ''
  child.stdout.on('data', chunk => { logs += chunk })
  child.stderr.on('data', chunk => { logs += chunk })
  const exited = new Promise((resolveExit, reject) => {
    child.once('exit', (code, signal) => resolveExit({ code, signal }))
    child.once('error', reject)
  })
  const leasePath = join(configDirectory, 'state/gateway.lock')
  const timer = setTimeout(() => child.kill('SIGKILL'), 40_000)
  try {
    let lease
    for (let attempt = 0; attempt < 300; attempt += 1) {
      if (child.exitCode !== null || child.signalCode) throw new Error(`Packaged Gateway exited:\n${logs}`)
      try { lease = JSON.parse(readFileSync(leasePath, 'utf8')) } catch { /* not ready */ }
      if (lease?.origin) break
      await delay(100)
    }
    assert.ok(lease?.origin, `Packaged Gateway never became ready:\n${logs}`)
    const response = await fetch(`${lease.origin}/api/health`, { signal: AbortSignal.timeout(5000) })
    assert.equal(response.status, 200)
    const health = await response.json()
    assert.equal(health.ok, true)
    assert.equal(health.gatewayInstanceId, lease.instanceId)
    // IPC disconnect is the existing cross-platform parent-exit contract.
    child.disconnect()
    const result = await exited
    assert.deepEqual(result, { code: 0, signal: null }, logs)
    assert.equal(existsSync(leasePath), false, 'Gateway must release its lease')
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL')
    await exited
  }
}

try {
  assert.ok(['darwin', 'win32', 'linux'].includes(process.platform), 'Unsupported desktop platform')
  let appDirectory = process.argv[2] ? resolve(process.argv[2]) : ''
  if (!appDirectory) {
    const platform = { darwin: '--mac', win32: '--win', linux: '--linux' }[process.platform]
    await run(process.execPath, [
      join(root, 'node_modules/electron-builder/cli.js'),
      '--config', 'desktop/electron-builder.yml', platform, `--${process.arch}`,
      '--dir', '--publish', 'never', `--config.directories.output=${outputDirectory}`,
      ...(process.platform === 'darwin' ? [
        '--config.mac.identity=null', '--config.mac.hardenedRuntime=false', '--config.mac.notarize=false',
      ] : []),
    ], { env: { ...environment, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } })
    const platformDirectory = process.platform === 'darwin'
      ? `mac${process.arch === 'x64' ? '' : `-${process.arch}`}`
      : `${process.platform === 'win32' ? 'win' : 'linux'}${process.arch === 'x64' ? '' : `-${process.arch}`}-unpacked`
    appDirectory = join(outputDirectory, platformDirectory,
      ...(process.platform === 'darwin' ? ['Qwen Audio Agent.app'] : []))
  }
  const resources = process.platform === 'darwin'
    ? join(appDirectory, 'Contents/Resources') : join(appDirectory, 'resources')
  const executable = process.platform === 'darwin'
    ? join(appDirectory, 'Contents/MacOS/Qwen Audio Agent')
    : join(appDirectory, process.platform === 'win32' ? 'Qwen Audio Agent.exe' : 'qwen-audio-agent')
  const archive = join(resources, 'app.asar')
  const files = new Set(listPackage(archive).map(file => file.replaceAll('\\', '/')))
  for (const file of ['desktop/src/main.mjs', 'server/src/index.mjs', 'shared/runtime-paths.mjs', 'web/dist/index.html']) {
    assert.ok(files.has(`/${file}`), `Desktop package is missing ${file}`)
  }
  assert.deepEqual(extractFile(archive, 'shared/runtime-paths.mjs'),
    readFileSync(join(resources, 'runtime/shared/runtime-paths.mjs')))
  const expectedElectron = JSON.parse(readFileSync(join(root, 'desktop/package.json'), 'utf8')).devDependencies.electron
  const electron = await run(executable, ['-p', 'process.versions.electron'], {
    env: { ...environment, ELECTRON_RUN_AS_NODE: '1' }, timeout: 10_000,
  })
  assert.equal(electron, expectedElectron, 'Build and tests must use the same Electron version')
  await checkGateway(executable, archive)
  process.stdout.write('Packaged desktop smoke passed: ASAR/resources, Electron version, Gateway health and clean shutdown.\n')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
