import assert from 'node:assert/strict'
import test from 'node:test'
import {
  compareSemanticVersions,
  createCurrentRuntimeMarker,
  createWslRuntimeInstallPlan,
  createWslRuntimeLayout,
  createWslRuntimeMarker,
  resolveWslRuntimeEntry,
  runtimeSetupState,
} from '../src/wsl-runtime-layout.mjs'

const expectedMarker = {
  desktopVersion: '1.2.0',
  packageVersion: '1.2.0',
  protocolVersion: 1,
  sha256: 'ab'.repeat(32),
  installedAt: '2026-08-03T00:00:00.000Z',
}

test('builds every private runtime path below the absolute WSL home', () => {
  assert.deepEqual(createWslRuntimeLayout({
    homeDirectory: '/home/tester',
    desktopVersion: '1.2.0',
  }), {
    homeDirectory: '/home/tester',
    privateRoot: '/home/tester/.local/share/qwaudio/windows-client',
    runtimeRoot: '/home/tester/.local/share/qwaudio/windows-client/runtime',
    versionDirectory:
      '/home/tester/.local/share/qwaudio/windows-client/runtime/1.2.0',
    executablePath:
      '/home/tester/.local/share/qwaudio/windows-client/runtime/1.2.0/node_modules/.bin/qwenaudio',
    versionMarkerPath:
      '/home/tester/.local/share/qwaudio/windows-client/runtime/1.2.0/runtime.json',
    currentMarkerPath:
      '/home/tester/.local/share/qwaudio/windows-client/current.json',
  })
})

test('rejects unsafe homes and desktop versions before building paths', () => {
  for (const desktopVersion of [
    '',
    '../1.2.0',
    '1.2.0/next',
    '1.2.0\\next',
    '1.2.0;rm',
    '1.2.0\nnext',
  ]) {
    assert.throws(() => createWslRuntimeLayout({
      homeDirectory: '/home/tester',
      desktopVersion,
    }), /desktop version/i)
  }
  for (const homeDirectory of ['', 'home/tester', '/home/tester\n/tmp']) {
    assert.throws(() => createWslRuntimeLayout({
      homeDirectory,
      desktopVersion: '1.2.0',
    }), /absolute WSL home/i)
  }
})

test('compares release and prerelease semantic versions', () => {
  assert.equal(compareSemanticVersions('1.2.0', '1.2.0'), 0)
  assert.equal(compareSemanticVersions('1.2.1', '1.2.0'), 1)
  assert.equal(compareSemanticVersions('1.10.0', '1.9.9'), 1)
  assert.equal(compareSemanticVersions('2.0.0-beta.1', '2.0.0'), -1)
  assert.throws(() => compareSemanticVersions('latest', '1.2.0'), /version/i)
})

test('creates validated version and last-known-good markers', () => {
  const marker = createWslRuntimeMarker(expectedMarker)
  assert.deepEqual(marker, expectedMarker)
  assert.throws(() => createWslRuntimeMarker({
    ...expectedMarker,
    sha256: 'not-a-sha',
  }), /SHA-256/)
  assert.throws(() => createCurrentRuntimeMarker({
    marker,
    bridgeReady: true,
    gatewayHealthy: false,
  }), /Gateway health/i)
  assert.deepEqual(createCurrentRuntimeMarker({
    marker,
    bridgeReady: true,
    gatewayHealthy: true,
    promotedAt: '2026-08-03T00:05:00.000Z',
  }), {
    desktopVersion: '1.2.0',
    packageVersion: '1.2.0',
    protocolVersion: 1,
    sha256: 'ab'.repeat(32),
    promotedAt: '2026-08-03T00:05:00.000Z',
  })
})

test('plans Node repair, runtime install, or ready reuse deterministically', () => {
  assert.deepEqual(runtimeSetupState({
    nodeVersion: '',
    npmVersion: '',
    marker: null,
    expectedMarker,
    executableExists: false,
  }), {
    state: 'node-required',
    missing: ['node', 'npm'],
  })
  assert.equal(runtimeSetupState({
    nodeVersion: 'v22.22.2',
    npmVersion: '10.9.4',
    marker: null,
    expectedMarker,
    executableExists: false,
  }).state, 'runtime-required')
  assert.equal(runtimeSetupState({
    nodeVersion: 'v22.22.2',
    npmVersion: '10.9.4',
    marker: { ...expectedMarker, packageVersion: '1.1.0' },
    expectedMarker,
    executableExists: true,
  }).state, 'runtime-required')
  assert.deepEqual(runtimeSetupState({
    nodeVersion: 'v22.22.2',
    npmVersion: '10.9.4',
    marker: expectedMarker,
    expectedMarker,
    executableExists: true,
  }), { state: 'ready' })
})

test('requires the Node.js and npm versions declared by the package', () => {
  const setup = (nodeVersion, npmVersion = '10.9.4') => runtimeSetupState({
    nodeVersion,
    npmVersion,
    marker: expectedMarker,
    expectedMarker,
    executableExists: true,
  })

  for (const nodeVersion of [
    'v20.19.0',
    'v22.22.1',
    'v23.11.1',
    'v24.14.0',
    'v25.1.0',
    'v26.0.0-rc.1',
    'not-a-version',
  ]) {
    assert.deepEqual(setup(nodeVersion), {
      state: 'node-required',
      missing: ['node'],
    })
  }

  for (const nodeVersion of [
    'v22.22.2',
    'v22.23.0',
    'v24.15.0',
    'v24.99.0',
    'v26.0.0',
    'v27.1.0',
  ]) {
    assert.deepEqual(setup(nodeVersion), { state: 'ready' })
  }

  for (const npmVersion of ['9.9.4', '10.0.0-rc.1', 'invalid']) {
    assert.deepEqual(setup('v22.22.2', npmVersion), {
      state: 'node-required',
      missing: ['npm'],
    })
  }
  assert.deepEqual(setup('v20.19.0', '9.9.4'), {
    state: 'node-required',
    missing: ['node', 'npm'],
  })
})

test('builds structured npm installation and a matching shell preview', () => {
  const layout = createWslRuntimeLayout({
    homeDirectory: '/home/tester',
    desktopVersion: '1.2.0',
  })
  const plan = createWslRuntimeInstallPlan({
    distribution: 'Ubuntu',
    layout,
    bundledTarballWslPath: '/mnt/c/Qwen Audio/qwen-audio-agent-1.2.0.tgz',
  })
  assert.deepEqual(plan.command, {
    file: 'wsl.exe',
    args: [
      '--distribution', 'Ubuntu',
      '--exec', 'bash', '-lic', 'exec "$@"',
      'qwaudio-desktop', 'npm',
      'install', '--omit=dev', '--ignore-scripts',
      '--prefix', layout.versionDirectory,
      '/mnt/c/Qwen Audio/qwen-audio-agent-1.2.0.tgz',
    ],
    options: { windowsHide: true, shell: false },
  })
  assert.equal(
    plan.displayCommand,
    'npm install --omit=dev --ignore-scripts --prefix '
      + '~/.local/share/qwaudio/windows-client/runtime/1.2.0 '
      + "'/mnt/c/Qwen Audio/qwen-audio-agent-1.2.0.tgz'",
  )
  assert.equal(plan.command.args.includes('~'), false)
})

test('rejects a forged layout outside the fixed private runtime root', () => {
  assert.throws(() => createWslRuntimeInstallPlan({
    distribution: 'Ubuntu',
    layout: {
      homeDirectory: '/home/tester',
      privateRoot: '/tmp/qwaudio',
      versionDirectory: '/tmp/qwaudio/runtime/1.2.0',
    },
    bundledTarballWslPath: '/mnt/c/Qwen/runtime.tgz',
  }), /private qwaudio root/i)
})

test('uses a development runtime override only for unpackaged Electron', () => {
  const packagedEntry = '/home/tester/.local/share/qwaudio/windows-client/'
    + 'runtime/1.2.0/node_modules/.bin/qwenaudio'
  assert.equal(resolveWslRuntimeEntry({
    appIsPackaged: false,
    env: {
      QWEN_AUDIO_DESKTOP_WSL_RUNTIME_ENTRY:
        '/home/tester/src/qwen-audio-agent/cli/bin/qwenaudio.mjs',
    },
    packagedEntry,
  }), '/home/tester/src/qwen-audio-agent/cli/bin/qwenaudio.mjs')
  assert.equal(resolveWslRuntimeEntry({
    appIsPackaged: true,
    env: { QWEN_AUDIO_DESKTOP_WSL_RUNTIME_ENTRY: '../../malicious' },
    packagedEntry,
  }), packagedEntry)
  assert.throws(() => resolveWslRuntimeEntry({
    appIsPackaged: false,
    env: { QWEN_AUDIO_DESKTOP_WSL_RUNTIME_ENTRY: 'relative/cli.mjs' },
    packagedEntry,
  }), /absolute WSL path/i)
})
