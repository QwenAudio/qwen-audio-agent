import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  validateWindowsReleaseEnvironment,
} from '../../scripts/check-windows-release-env.mjs'
import {
  parseWindowsBuilderArguments,
  publishWindowsDesktopOutput,
  publishWindowsDesktopOutputThroughWsl,
  shouldStageWindowsOutput,
  windowsBuilderInvocation,
} from '../../scripts/build-windows-desktop.mjs'

function topLevelYamlSection(source, name) {
  const lines = source.split('\n')
  const start = lines.findIndex(line => line === `${name}:`)
  assert.notEqual(start, -1, `missing ${name} section`)
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^[a-zA-Z][\w-]*:/.test(lines[index])) {
      end = index
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

test('formal Windows builds require a PFX password or installed certificate selector', () => {
  assert.throws(
    () => validateWindowsReleaseEnvironment({}),
    /WIN_CSC_LINK.*WIN_CSC_SUBJECT_NAME/,
  )
  assert.throws(
    () => validateWindowsReleaseEnvironment({
      WIN_CSC_LINK: 'private-release-certificate.pfx',
    }),
    error => (
      /WIN_CSC_KEY_PASSWORD/.test(error.message)
      && !error.message.includes('private-release-certificate.pfx')
    ),
  )
  assert.doesNotThrow(() => validateWindowsReleaseEnvironment({
    WIN_CSC_LINK: 'private-release-certificate.pfx',
    WIN_CSC_KEY_PASSWORD: 'private-password',
  }))
  assert.doesNotThrow(() => validateWindowsReleaseEnvironment({
    WIN_CSC_SUBJECT_NAME: 'Qwen Audio Release',
  }))
})

test('builder invocations are x64 NSIS only and local builds cannot sign or publish', () => {
  const signed = windowsBuilderInvocation({
    env: { WIN_CSC_SUBJECT_NAME: 'Qwen Audio Release' },
  })
  assert.deepEqual(signed.args.slice(0, 6), [
    '--config',
    'desktop/electron-builder.yml',
    '--win',
    'nsis',
    '--x64',
    '--publish',
  ])
  assert.equal(signed.args[6], 'never')
  assert.equal(signed.args.some(arg => arg.includes('arm64')), false)
  assert.equal(signed.args.some(arg => (
    arg === '--config.win.signtoolOptions.certificateSubjectName=Qwen Audio Release'
  )), true)

  const local = windowsBuilderInvocation({
    local: true,
    env: {
      WIN_CSC_LINK: 'must-not-reach-builder.pfx',
      WIN_CSC_KEY_PASSWORD: 'must-not-reach-builder',
      CSC_LINK: 'must-not-reach-builder.p12',
      CSC_KEY_PASSWORD: 'must-not-reach-builder',
    },
  })
  assert.equal(local.args.includes('--config.win.forceCodeSigning=false'), true)
  assert.equal(local.args.includes('never'), true)
  assert.equal(local.env.CSC_IDENTITY_AUTO_DISCOVERY, 'false')
  for (const name of [
    'WIN_CSC_LINK',
    'WIN_CSC_KEY_PASSWORD',
    'CSC_LINK',
    'CSC_KEY_PASSWORD',
  ]) assert.equal(name in local.env, false)
})

test('Windows UNC builds use a native output directory before publishing', async () => {
  assert.equal(shouldStageWindowsOutput({
    platform: 'win32',
    rootDirectory: '\\\\wsl.localhost\\Ubuntu\\home\\tester\\repo',
  }), true)
  assert.equal(shouldStageWindowsOutput({
    platform: 'win32',
    rootDirectory: 'C:\\src\\qwen-audio-agent',
  }), false)
  assert.equal(shouldStageWindowsOutput({
    platform: 'win32',
    rootDirectory: 'Z:\\home\\tester\\repo',
    force: true,
  }), true)
  assert.equal(shouldStageWindowsOutput({
    platform: 'linux',
    rootDirectory: '\\\\wsl.localhost\\Ubuntu\\home\\tester\\repo',
  }), false)

  const invocation = windowsBuilderInvocation({
    local: true,
    outputDirectory: 'C:\\Temp\\qwen-audio-agent-desktop-123',
  })
  assert.equal(invocation.args.includes(
    '--config.directories.output=C:\\Temp\\qwen-audio-agent-desktop-123',
  ), true)

  const temporaryRoot = await mkdtemp(join(
    tmpdir(),
    'qwen-audio-windows-publish-test-',
  ))
  const staging = join(temporaryRoot, 'staging')
  const destination = join(temporaryRoot, 'destination')
  try {
    await mkdir(join(staging, 'win-unpacked'), { recursive: true })
    await mkdir(join(destination, 'win-unpacked'), { recursive: true })
    await mkdir(join(destination, 'verification'), { recursive: true })
    await writeFile(join(staging, 'win-unpacked', 'Qwen Audio Agent.exe'), 'new')
    await writeFile(join(staging, 'latest.yml'), 'path: installer.exe\n')
    await writeFile(join(staging, 'installer.exe'), 'installer')
    await writeFile(join(destination, 'win-unpacked', 'stale.dll'), 'stale')
    await writeFile(join(destination, 'verification', 'keep.txt'), 'keep')

    publishWindowsDesktopOutput({ staging, destination })

    assert.equal(
      await readFile(join(
        destination,
        'win-unpacked',
        'Qwen Audio Agent.exe',
      ), 'utf8'),
      'new',
    )
    await assert.rejects(
      readFile(join(destination, 'win-unpacked', 'stale.dll')),
      error => error?.code === 'ENOENT',
    )
    assert.equal(
      await readFile(join(destination, 'verification', 'keep.txt'), 'utf8'),
      'keep',
    )
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('WSL staging arguments and publishing remain structured', () => {
  assert.deepEqual(parseWindowsBuilderArguments([
    '--local',
    '--stage-output',
    '--wsl-distribution',
    'Ubuntu Dev',
    '--wsl-project-directory',
    '/home/tester/Qwen Audio',
  ]), {
    local: true,
    stageOutput: true,
    wslDistribution: 'Ubuntu Dev',
    wslProjectDirectory: '/home/tester/Qwen Audio',
  })
  assert.throws(
    () => parseWindowsBuilderArguments(['--stage-output', '--wsl-distribution']),
    /argument/i,
  )
  assert.throws(
    () => parseWindowsBuilderArguments([
      '--stage-output',
      '--wsl-distribution',
      'Ubuntu',
    ]),
    /together/i,
  )

  const calls = []
  const file = name => ({
    name,
    isFile: () => true,
    isDirectory: () => false,
  })
  const directory = name => ({
    name,
    isFile: () => false,
    isDirectory: () => true,
  })
  publishWindowsDesktopOutputThroughWsl({
    staging: 'C:\\Temp\\qwen-audio-agent-desktop-123',
    distribution: 'Ubuntu Dev',
    projectDirectory: '/home/tester/Qwen Audio',
    fileSystem: {
      readdirSync: () => [directory('win-unpacked'), file('latest.yml')],
    },
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options })
      return args.includes('wslpath')
        ? { status: 0, stdout: '/mnt/c/Temp/qwen-audio-agent-desktop-123\n' }
        : { status: 0, stdout: '' }
    },
  })

  assert.equal(calls.every(call => call.command === 'wsl.exe'), true)
  assert.equal(calls.every(call => call.options.shell === false), true)
  assert.equal(calls.every(call => call.args.slice(0, 2).join(' ') === (
    '--distribution Ubuntu Dev'
  )), true)
  assert.equal(calls.some(call => call.args.includes('wslpath')), true)
  assert.equal(calls.some(call => call.args.includes('--recursive')), true)
  assert.equal(calls.some(call => call.args.includes(
    '/home/tester/Qwen Audio/dist/desktop/latest.yml',
  )), true)
})

test('electron-builder fixes the Windows installer and bundled WSL payload contract', async () => {
  const [config, installer] = await Promise.all([
    readFile(new URL('../electron-builder.yml', import.meta.url), 'utf8'),
    readFile(new URL('../build/installer.nsh', import.meta.url), 'utf8'),
  ])
  const win = topLevelYamlSection(config, 'win')
  const nsis = topLevelYamlSection(config, 'nsis')

  assert.match(win, /target:\s*[\s\S]*- target: nsis\s*[\s\S]*arch:\s*[\s\S]*- x64/)
  assert.doesNotMatch(win, /arm64|ia32/)
  assert.match(win, /icon: desktop\/build\/icon\.png/)
  assert.match(win, /forceCodeSigning: true/)
  assert.match(win, /artifactName: qwen-audio-agent-\$\{version\}-windows-\$\{arch\}\.\$\{ext\}/)
  assert.match(win, /signingHashAlgorithms:\s*[\s\S]*- sha256/)
  assert.match(win, /rfc3161TimeStampServer: https:\/\/timestamp\.digicert\.com/)

  const nsisProperties = new Set(nsis.split('\n').map(line => line.trim()))
  for (const property of [
    'oneClick: false',
    'perMachine: false',
    'allowElevation: false',
    'allowToChangeInstallationDirectory: true',
    'createStartMenuShortcut: true',
    'createDesktopShortcut: true',
    'shortcutName: Qwen Audio Agent',
    'uninstallDisplayName: Qwen Audio Agent',
    'deleteAppDataOnUninstall: false',
    'include: desktop/build/installer.nsh',
  ]) assert.equal(
    nsisProperties.has(property),
    true,
    `missing exact NSIS property: ${property}`,
  )

  assert.equal(installer.trim(), [
    '!macro customInstallMode',
    '  StrCpy $isForceCurrentInstall "1"',
    '!macroend',
  ].join('\n'))

  assert.match(win, /extraResources:\s*[\s\S]*from: dist\/wsl-runtime/)
  assert.match(win, /to: wsl-runtime/)
  assert.match(win, /- "\*\*\/\*"/)
})

test('package scripts build web and payload before separate signed and local Windows builds', async () => {
  const manifest = JSON.parse(await readFile(
    new URL('../../package.json', import.meta.url),
    'utf8',
  ))
  const formal = manifest.scripts['desktop:build:win']
  const local = manifest.scripts['desktop:build:win:local']
  for (const command of [formal, local]) {
    assert.match(command, /npm run build/)
    assert.match(command, /npm run build:wsl-runtime-payload/)
    assert.match(command, /build-windows-desktop\.mjs/)
  }
  assert.doesNotMatch(formal, /--local/)
  assert.match(local, /--local/)
})

test('CI builds unsigned Windows artifacts while releases require valid Authenticode', async () => {
  const [ci, release] = await Promise.all([
    readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
    readFile(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8'),
  ])
  assert.match(ci, /windows-installer:[\s\S]*runs-on: windows-latest/)
  assert.match(ci, /npm run desktop:build:win:local/)
  assert.match(ci, /dist\/desktop\/\*windows-x64\.exe/)
  assert.match(ci, /dist\/desktop\/latest\.yml/)

  assert.match(release, /windows:[\s\S]*runs-on: windows-latest/)
  assert.match(release, /WIN_CSC_LINK: \$\{\{ secrets\.WIN_CSC_LINK \}\}/)
  assert.match(release, /npm run desktop:build:win/)
  assert.match(release, /Get-AuthenticodeSignature/)
  assert.match(release, /Status -ne ['"]Valid['"]/)
  assert.match(release, /github-release:[\s\S]*needs: \[plan, tag, npm, macos, windows\]/)
})
