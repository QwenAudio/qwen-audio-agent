import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertDiscoveredDistribution,
  buildWslCommand,
  buildWslLoginCommand,
  convertWindowsPathToWsl,
  decodeWslOutput,
  parseWslDistributionList,
  parseWslVerboseList,
  probeWslRuntime,
  selectWslDistribution,
  WSL_RUNTIME_PROBE_SOURCE,
} from '../src/wsl-discovery.mjs'

function utf16le(value) {
  return Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(value, 'utf16le'),
  ])
}

test('decodes BOM-marked UTF-16LE and UTF-8 WSL output', () => {
  assert.equal(
    decodeWslOutput(utf16le('Ubuntu\r\nDebian\r\n')),
    'Ubuntu\r\nDebian\r\n',
  )
  assert.equal(
    decodeWslOutput(Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('Ubuntu\n', 'utf8'),
    ])),
    'Ubuntu\n',
  )
})

test('parses quiet distribution output without losing valid user names', () => {
  const output = utf16le([
    '\u0000Ubuntu\u0000',
    '  Debian  ',
    'Ubuntu',
    'docker-desktop',
    'docker-desktop-data',
    '',
  ].join('\r\n'))
  const distributions = parseWslDistributionList(output)
  assert.deepEqual(distributions, [
    'Ubuntu',
    'Debian',
    'docker-desktop',
    'docker-desktop-data',
  ])
  assert.equal(selectWslDistribution({ distributions }), 'Ubuntu')
  assert.equal(selectWslDistribution({
    distributions,
    defaultName: 'Debian',
  }), 'Debian')
})

test('parses verbose output with defaults, spaces, states, and WSL versions', () => {
  const output = utf16le([
    '  NAME                   STATE           VERSION',
    '* Ubuntu 24.04 LTS       Running         2',
    '  Debian Dev             Stopped         2',
    '  Legacy Linux           Stopped         1',
  ].join('\r\n'))

  assert.deepEqual(parseWslVerboseList(output), [
    {
      name: 'Ubuntu 24.04 LTS',
      state: 'Running',
      version: 2,
      isDefault: true,
    },
    {
      name: 'Debian Dev',
      state: 'Stopped',
      version: 2,
      isDefault: false,
    },
    {
      name: 'Legacy Linux',
      state: 'Stopped',
      version: 1,
      isDefault: false,
    },
  ])
})

test('validates only current discovered distribution names', () => {
  const discovered = ['Ubuntu', 'Debian Dev']
  assert.equal(
    assertDiscoveredDistribution('Debian Dev', discovered),
    'Debian Dev',
  )
  for (const invalid of [
    '',
    ' Ubuntu',
    'Ubuntu ',
    'Ubuntu\nOther',
    'Missing',
  ]) {
    assert.throws(
      () => assertDiscoveredDistribution(invalid, discovered),
      /distribution/i,
    )
  }
})

test('rejects a selected WSL1 distribution with an actionable reason', () => {
  const distributions = [
    { name: 'Legacy', state: 'Stopped', version: 1, isDefault: true },
    { name: 'Ubuntu', state: 'Running', version: 2, isDefault: false },
  ]
  assert.throws(
    () => selectWslDistribution({ distributions }),
    error => error.reason === 'wsl2-required',
  )
  assert.equal(selectWslDistribution({
    distributions,
    configured: 'Ubuntu',
  }), 'Ubuntu')
})

test('builds direct and login WSL commands with structured arguments', () => {
  assert.deepEqual(buildWslCommand({
    distribution: 'Ubuntu Dev',
    executable: 'wslpath',
    args: ['-a', '-u', 'C:\\Program Files\\Qwen\\runtime.tgz'],
  }), {
    file: 'wsl.exe',
    args: [
      '--distribution', 'Ubuntu Dev',
      '--exec', 'wslpath',
      '-a', '-u', 'C:\\Program Files\\Qwen\\runtime.tgz',
    ],
    options: { windowsHide: true, shell: false },
  })

  assert.deepEqual(buildWslLoginCommand({
    distribution: 'Ubuntu Dev',
    executable: 'node',
    args: ['--version'],
  }), {
    file: 'wsl.exe',
    args: [
      '--distribution', 'Ubuntu Dev',
      '--exec', 'bash', '-lic', 'exec "$@"',
      'qwaudio-desktop', 'node', '--version',
    ],
    options: { windowsHide: true, shell: false },
  })
})

test('runs the fixed WSL discovery and selected-runtime probe sequence', async () => {
  const calls = []
  const outputs = [
    Buffer.from('Default Distribution: Ubuntu\n'),
    utf16le('Ubuntu\r\nDebian\r\n'),
    utf16le([
      '  NAME      STATE    VERSION',
      '* Ubuntu    Running  2',
      '  Debian    Stopped  2',
    ].join('\r\n')),
    Buffer.from('Ubuntu\n'),
    Buffer.from(`${JSON.stringify({
      version: 1,
      home: '/home/tester',
      distribution: 'Ubuntu',
      architecture: 'x86_64',
      nodeVersion: 'v22.22.2',
      npmVersion: '10.9.4',
      runtime: { currentMarkerExists: false },
    })}\n`),
  ]
  const result = await probeWslRuntime({
    runCommand: async command => {
      calls.push(command)
      return { stdout: outputs.shift(), stderr: Buffer.alloc(0), code: 0 }
    },
  })

  assert.deepEqual(calls.slice(0, 4), [
    {
      file: 'wsl.exe',
      args: ['--status'],
      options: { windowsHide: true, shell: false },
    },
    {
      file: 'wsl.exe',
      args: ['--list', '--quiet'],
      options: { windowsHide: true, shell: false },
    },
    {
      file: 'wsl.exe',
      args: ['--list', '--verbose'],
      options: { windowsHide: true, shell: false },
    },
    {
      file: 'wsl.exe',
      args: [
        '--exec', 'sh', '-c',
        'printf "%s" "$WSL_DISTRO_NAME"',
      ],
      options: { windowsHide: true, shell: false },
    },
  ])
  assert.deepEqual(calls[4], buildWslLoginCommand({
    distribution: 'Ubuntu',
    executable: 'node',
    args: ['--eval', WSL_RUNTIME_PROBE_SOURCE],
  }))
  assert.equal(result.selected, 'Ubuntu')
  assert.equal(result.probe.home, '/home/tester')
  assert.equal(result.probe.runtime.currentMarkerExists, false)
  assert.equal(calls[4].args.includes('~'), false)
})

test('selects from the verbose list when WSL reports no default name', async () => {
  const outputs = [
    Buffer.from('WSL status\n'),
    Buffer.from('Ubuntu\n'),
    Buffer.from('  NAME      STATE    VERSION\n  Ubuntu    Stopped  2\n'),
    Buffer.alloc(0),
    Buffer.from(`${JSON.stringify({
      version: 1,
      home: '/home/tester',
      distribution: 'Ubuntu',
      architecture: 'x86_64',
      nodeVersion: 'v22.22.2',
      npmVersion: '10.9.4',
      runtime: { currentMarkerExists: false },
    })}\n`),
  ]
  const result = await probeWslRuntime({
    runCommand: async () => ({ stdout: outputs.shift(), code: 0 }),
  })
  assert.equal(result.defaultName, '')
  assert.equal(result.selected, 'Ubuntu')
})

test('reports an actionable reason when no user distribution exists', async () => {
  const outputs = [
    Buffer.from('WSL status\n'),
    Buffer.from('docker-desktop\n'),
    Buffer.from('  NAME              STATE    VERSION\n'
      + '* docker-desktop    Running  2\n'),
    Buffer.from('docker-desktop\n'),
  ]
  await assert.rejects(probeWslRuntime({
    runCommand: async () => ({ stdout: outputs.shift(), code: 0 }),
  }), error => error.reason === 'no-distributions')
})

test('maps command failures to the discovery stage without exposing output', async () => {
  await assert.rejects(probeWslRuntime({
    runCommand: async () => {
      const error = new Error('spawn wsl.exe ENOENT token=secret')
      error.stdout = Buffer.from('token=secret')
      throw error
    },
  }), error => (
    error.reason === 'wsl-unavailable'
    && !error.message.includes('token=secret')
  ))
})

test('converts an absolute Windows path through structured wslpath arguments', async () => {
  const calls = []
  const converted = await convertWindowsPathToWsl({
    distribution: 'Ubuntu',
    windowsPath: 'C:\\Program Files\\Qwen\\runtime.tgz',
    runCommand: async command => {
      calls.push(command)
      return { stdout: Buffer.from('/mnt/c/Program Files/Qwen/runtime.tgz\n') }
    },
  })
  assert.equal(converted, '/mnt/c/Program Files/Qwen/runtime.tgz')
  assert.deepEqual(calls[0], buildWslCommand({
    distribution: 'Ubuntu',
    executable: 'wslpath',
    args: ['-a', '-u', 'C:\\Program Files\\Qwen\\runtime.tgz'],
  }))
})

test('rejects unsafe Windows inputs and invalid wslpath output', async () => {
  const neverRun = async () => {
    throw new Error('must not execute')
  }
  for (const windowsPath of ['', 'relative\\file.tgz', 'C:\\one\nother']) {
    await assert.rejects(convertWindowsPathToWsl({
      distribution: 'Ubuntu',
      windowsPath,
      runCommand: neverRun,
    }), /absolute Windows path/i)
  }
  for (const output of [
    '',
    'relative/path\n',
    '/one\n/two\n',
    '/mnt/c/one/../two\n',
  ]) {
    await assert.rejects(convertWindowsPathToWsl({
      distribution: 'Ubuntu',
      windowsPath: 'C:\\Qwen\\runtime.tgz',
      runCommand: async () => ({ stdout: Buffer.from(output) }),
    }), /absolute WSL path/i)
  }
})
