// The acceptance test for a consumer, run exactly the way a user experiences
// it: pack the published artifact, install it into a bare consumer whose
// node_modules holds nothing but this package's declared dependencies, then
// drive the CLI and the Gateway.
//
// This catches the class of bug that a workspaces install hides: the module
// graph reaching a package only a private workspace had declared, files
// missing from the published `files` list, and contract fields absent from
// /api/health.
//
// The test needs npm and the registry, which a plain unit run should not
// depend on, so it only runs when explicitly enabled:
//
//   QWEN_AUDIO_CONSUMER_PROBE=1 node --test test/consumer-install.test.mjs
//
// CI enables it on one matrix job after the build step.

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(fileURLToPath(import.meta.url), '../..')
const enabled = process.env.QWEN_AUDIO_CONSUMER_PROBE === '1'

function installedRoot(consumer) {
  return join(consumer, 'node_modules', 'qwen-audio-agent')
}

async function waitForLease(configDir, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const lease = JSON.parse(readFileSync(join(configDir, 'gateway.lock'), 'utf8'))
      if (lease.origin) return lease
    } catch {
      // Not written yet.
    }
    await new Promise(resolvePoll => setTimeout(resolvePoll, 100))
  }
  throw new Error('gateway.lock never reported an origin')
}

test('a consumer with only the declared dependencies can run the CLI and Gateway', { skip: !enabled }, async t => {
  const pack = spawnSync('npm', ['pack', '--ignore-scripts'], {
    cwd: projectRoot,
    encoding: 'utf8',
  })
  assert.equal(pack.status, 0, `npm pack failed: ${pack.stderr}`)
  const tarball = pack.stdout.trim().split('\n').pop()
  assert.ok(tarball.endsWith('.tgz'), `unexpected pack output: ${pack.stdout}`)
  t.after(() => rmSync(resolve(projectRoot, tarball), { force: true }))

  const consumer = mkdtempSync(join(tmpdir(), 'qwaudio-consumer-'))
  t.after(() => rmSync(consumer, { recursive: true, force: true }))
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({
    name: 'qwaudio-consumer-probe',
    private: true,
    type: 'module',
    dependencies: {
      'qwen-audio-agent': `file:${resolve(projectRoot, tarball)}`,
    },
  }))

  const install = spawnSync('npm', [
    'install',
    '--no-audit',
    '--no-fund',
    '--ignore-scripts',
    '--loglevel=error',
  ], { cwd: consumer, encoding: 'utf8' })
  assert.equal(install.status, 0, `consumer npm install failed: ${install.stderr}`)

  // 1. The CLI entry resolves its whole import graph from the consumer's
  //    node_modules alone.
  const help = spawnSync(process.execPath, [
    join(installedRoot(consumer), 'cli/bin/qwenaudio.mjs'),
    '--help',
  ], { cwd: consumer, encoding: 'utf8' })
  assert.equal(help.status, 0, `qwenaudio --help failed: ${help.stderr}`)
  assert.match(help.stdout, /qwenaudio/)

  const sdk = spawnSync(process.execPath, [
    '--input-type=module',
    '--eval',
    [
      "import { BACKEND_ADAPTER_SDK_VERSION, defineBackendAdapter } from 'qwen-audio-agent/backend-adapter-sdk'",
      "if (BACKEND_ADAPTER_SDK_VERSION !== '3.0.0') process.exit(2)",
      "if (typeof defineBackendAdapter !== 'function') process.exit(3)",
    ].join(';'),
  ], { cwd: consumer, encoding: 'utf8' })
  assert.equal(sdk.status, 0, `Backend Adapter SDK import failed: ${sdk.stderr}`)

  // 2. The setup gate: an unconfigured Gateway start must refuse with an
  //    actionable error instead of listening with a dead voice.
  const gateEnvironment = {
    ...process.env,
    QWAUDIO_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'qwaudio-gate-')),
    QWEN_AUDIO_LOG_CONSOLE: '1',
    DASHSCOPE_API_KEY: '',
    QWEN_AUDIO_REALTIME_API_KEY: '',
    AGENT_PROTOCOL: '',
  }
  const refused = spawnSync(process.execPath, [
    join(installedRoot(consumer), 'server/src/index.mjs'),
  ], { cwd: consumer, encoding: 'utf8', env: gateEnvironment, timeout: 60_000 })
  assert.notEqual(refused.status, 0, 'an unconfigured start must not succeed')
  assert.match(
    `${refused.stdout}\n${refused.stderr}`,
    /DASHSCOPE_API_KEY/,
    'the refusal must name what is missing',
  )

  // 3. A configured start serves the health contract; the lease is how a
  //    consumer finds the system-assigned port without bookkeeping.
  const configDir = mkdtempSync(join(tmpdir(), 'qwaudio-probe-'))
  t.after(() => rmSync(configDir, { recursive: true, force: true }))
  const gateway = spawn(process.execPath, [
    join(installedRoot(consumer), 'server/src/index.mjs'),
  ], {
    cwd: consumer,
    env: {
      ...process.env,
      QWAUDIO_CONFIG_DIR: configDir,
      DASHSCOPE_API_KEY: 'sk-consumer-probe',
      AGENT_PROTOCOL: '',
      PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output = []
  gateway.stdout.on('data', chunk => output.push(chunk))
  gateway.stderr.on('data', chunk => output.push(chunk))
  t.after(() => gateway.kill('SIGKILL'))

  const lease = await waitForLease(configDir)
  const health = await fetch(`${lease.origin}/api/health`).then(res => res.json())
  assert.equal(health.ok, true, `health not ok: ${output.join('')}`)
  assert.ok(health.protocolVersion, 'health lacks protocolVersion')
  assert.ok(
    health.capabilities?.includes('input.suspend-protocol'),
    'health lacks the input.suspend-protocol capability',
  )
  assert.equal(health.gatewayInstanceId, lease.instanceId,
    'health must echo the lease instanceId')

  // 4. The input control plane answers a consumer round trip.
  const suspended = await fetch(`${lease.origin}/api/input/suspend`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ owner: 'consumer-probe', ttlMs: 5000 }),
  }).then(res => res.json())
  assert.equal(suspended.suspended, true)
  const resumed = await fetch(`${lease.origin}/api/input/resume`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ owner: 'consumer-probe' }),
  }).then(res => res.json())
  assert.equal(resumed.suspended, false)

  // 5. SIGTERM shuts down cleanly and releases the lease.
  const exited = new Promise(resolveExit => gateway.once('exit', resolveExit))
  gateway.kill('SIGTERM')
  await exited
  assert.throws(
    () => readFileSync(join(configDir, 'gateway.lock')),
    'a clean shutdown must release the lease',
  )

  // 6. The embedding flow, exactly as a CommonJS Electron host runs it:
  //    require the CJS bridge, collect settings through the store, import a
  //    skin, host the Gateway through GatewayProcess, and read the skin back
  //    from the Gateway origin.
  writeFileSync(join(consumer, 'embed-probe.cjs'), `
const assert = require('node:assert/strict')
const { fork } = require('node:child_process')
const { mkdirSync, mkdtempSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

// A minimal VP8X WebP header with the sprite sheet dimensions the skin
// validator expects (1536x1872 = 8 columns x 9 rows of 192x208).
function makeWebp(width, height) {
  const buffer = Buffer.alloc(30)
  buffer.write('RIFF', 0, 'latin1')
  buffer.writeUInt32LE(22, 4)
  buffer.write('WEBP', 8, 'latin1')
  buffer.write('VP8X', 12, 'latin1')
  buffer.writeUInt32LE(10, 16)
  buffer.writeUIntLE(width - 1, 24, 3)
  buffer.writeUIntLE(height - 1, 27, 3)
  return buffer
}

async function main() {
  const audioAgent = require('qwen-audio-agent/electron')
  const api = await audioAgent.load()
  assert.equal(typeof audioAgent.PRELOAD_PATH, 'string')
  for (const name of [
    'createGatewayProcess', 'createSettingsStore', 'gatewaySetupStatus',
    'importSkin', 'listSkins', 'effectiveOrbSkin', 'skinsDirectory',
    'bindOrbShell', 'createOrbWindow', 'createOrbPlacement',
    'desktopOrbUrl', 'DesktopPresence',
  ]) {
    assert.equal(typeof api[name], 'function', name + ' must be exported')
  }
  assert.ok(api.GATEWAY_CAPABILITIES.includes('host.electron-entry'))

  // Settings are collected through the store, never through a file the host
  // names itself.
  const configDir = mkdtempSync(join(tmpdir(), 'qwaudio-embed-'))
  const settings = api.createSettingsStore({ configDir })
  assert.equal(settings.ready(), false)
  settings.save({ dashscopeApiKey: 'sk-embed-probe' })
  assert.equal(settings.ready(), true)

  // Import a skin before the Gateway starts; the Gateway then serves it.
  const skinSource = mkdtempSync(join(tmpdir(), 'qwaudio-skin-'))
  mkdirSync(join(skinSource, 'probe--host'), { recursive: true })
  writeFileSync(join(skinSource, 'probe--host', 'pet.json'), JSON.stringify({
    id: 'probe--host',
    displayName: 'Probe',
    spritesheetPath: 'spritesheet.webp',
  }))
  writeFileSync(
    join(skinSource, 'probe--host', 'spritesheet.webp'),
    makeWebp(1536, 1872),
  )
  const skinsRoot = api.skinsDirectory(configDir)
  const imported = await api.importSkin({
    source: join(skinSource, 'probe--host'),
    skinsRoot,
  })
  assert.equal(imported.id, 'probe--host')
  assert.equal(api.effectiveOrbSkin('probe--host', { skinsRoot }), 'probe--host')

  // Host the Gateway as a child process; a plain Node host injects fork.
  const gateway = api.createGatewayProcess({
    configDir,
    backend: 'none',
    preferredPort: 0,
    forkImpl: (entry, args, options) => fork(entry, args, {
      ...options,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    }),
  })
  const origin = await gateway.start()
  const health = await fetch(origin + '/api/health').then(res => res.json())
  assert.ok(health.capabilities.includes('web.skin-assets'))
  const petManifest = await fetch(origin + '/skins/probe--host/pet.json')
  assert.equal(petManifest.status, 200, 'the Gateway must serve imported skins')
  const skinUrl = new URL(api.desktopOrbUrl(origin, { orbSkin: 'probe--host' }))
  assert.equal(skinUrl.searchParams.get('orbSkin'), 'probe--host')
  await gateway.stop()
  console.log('embedding probe ok')
}

main().then(() => process.exit(0), error => {
  console.error(error)
  process.exit(1)
})
`)
  const embed = spawnSync(process.execPath, ['embed-probe.cjs'], {
    cwd: consumer,
    encoding: 'utf8',
    timeout: 120_000,
  })
  assert.equal(embed.status, 0, `embedding probe failed: ${embed.stdout}\n${embed.stderr}`)
  assert.match(embed.stdout, /embedding probe ok/)
})
