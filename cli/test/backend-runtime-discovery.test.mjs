import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function fixture() {
  const directory = mkdtempSync(resolve(tmpdir(), 'qwen-backend-runtime-'))
  const bin = resolve(directory, 'bin')
  const capture = resolve(directory, 'capture.txt')
  mkdirSync(bin)
  return {
    directory,
    bin,
    capture,
    close: () => rmSync(directory, { recursive: true, force: true }),
  }
}

function command(path, {
  version = '',
  captureModels = false,
  captureNativePaths = false,
  capturePiBin = false,
} = {}) {
  writeFileSync(path, [
    '#!/bin/sh',
    ...(version ? [
      'if [ "${1:-}" = "--version" ]; then',
      `  printf "%s\\n" "${version}"`,
      '  exit 0',
      'fi',
    ] : []),
    'printf "%s\\n" "$(basename "$0")" "$@" > "$CAPTURE"',
    ...(captureModels ? [
      'printf "%s\\n" "OPENCODE_MODEL=${OPENCODE_MODEL:-}" >> "$CAPTURE"',
      'printf "%s\\n" "OPENCLAW_MODEL=${QWEN_AUDIO_AGENT_OPENCLAW_MODEL:-}" >> "$CAPTURE"',
      'printf "%s\\n" "OPENCLAW_MODEL_ID=${QWEN_AUDIO_AGENT_OPENCLAW_MODEL_ID:-}" >> "$CAPTURE"',
      'printf "%s\\n" "OPENCLAW_CONFIG_PATH=${OPENCLAW_CONFIG_PATH:-}" >> "$CAPTURE"',
      'printf "%s\\n" "OPENCLAW_STATE_DIR=${OPENCLAW_STATE_DIR:-}" >> "$CAPTURE"',
    ] : []),
    ...(captureNativePaths ? [
      'printf "%s\\n" "CODEX_PATH=${CODEX_PATH:-}" >> "$CAPTURE"',
      'printf "%s\\n" "CLAUDE_CODE_EXECUTABLE=${CLAUDE_CODE_EXECUTABLE:-}" >> "$CAPTURE"',
    ] : []),
    ...(capturePiBin ? [
      'printf "%s\\n" "PI_BIN=${PI_BIN:-}" >> "$CAPTURE"',
      'printf "%s\\n" "PI_ACP_PI_COMMAND=${PI_ACP_PI_COMMAND:-}" >> "$CAPTURE"',
    ] : []),
    '',
  ].join('\n'))
  chmodSync(path, 0o755)
}

function execute(script, target, env = {}, args = []) {
  return spawnSync(process.execPath, [resolve(root, script), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      HOME: target.directory,
      PATH: `${target.bin}:/usr/bin:/bin`,
      CAPTURE: target.capture,
      QWEN_AUDIO_AGENT_ENV_LOADED: '1',
      QWEN_AUDIO_AGENT_NODE: process.execPath,
      QWAUDIO_CONFIG_DIR: resolve(target.directory, 'config'),
      OPENCLAW_BUNDLE_BIN: '',
      ...env,
    },
  })
}

function run(script, target, env = {}, args = []) {
  const result = execute(script, target, env, args)
  assert.equal(result.status, 0, result.stderr)
  return readFileSync(target.capture, 'utf8').trim().split('\n')
}

test('OpenCode auto mode prefers the user-installed command', {
  skip: process.platform === 'win32',
}, () => {
  const target = fixture()
  try {
    command(resolve(target.bin, 'opencode'), { version: '1.20.0' })
    command(resolve(target.bin, 'npx'))
    assert.deepEqual(run('scripts/opencode-server.mjs', target, {
      OPENCODE_RUNTIME: 'auto',
      OPENCODE_PORT: '4321',
    }), [
      'opencode',
      'serve',
      '--hostname',
      '127.0.0.1',
      '--port',
      '4321',
    ])
  } finally {
    target.close()
  }
})

test('OpenCode auto mode downloads a pinned package when missing', {
  skip: process.platform === 'win32',
}, () => {
  const target = fixture()
  try {
    command(resolve(target.bin, 'npx'))
    assert.deepEqual(run('scripts/opencode-server.mjs', target, {
      OPENCODE_RUNTIME: 'auto',
      OPENCODE_PORT: '4321',
      DASHSCOPE_API_KEY: 'test-key',
      QWEN_AUDIO_AGENT_BACKEND_MODEL: 'qwen3.7-max',
    }), [
      'npx',
      '--yes',
      'opencode-ai@1.18.5',
      'serve',
      '--hostname',
      '127.0.0.1',
      '--port',
      '4321',
    ])
  } finally {
    target.close()
  }
})

test('OpenCode auto mode replaces an incompatible version with the pinned package', {
  skip: process.platform === 'win32',
}, () => {
  const target = fixture()
  try {
    command(resolve(target.bin, 'opencode'), { version: '1.1.53' })
    command(resolve(target.bin, 'npx'))
    assert.deepEqual(run('scripts/opencode-server.mjs', target, {
      OPENCODE_RUNTIME: 'auto',
      OPENCODE_PORT: '4321',
      DASHSCOPE_API_KEY: 'test-key',
      QWEN_AUDIO_AGENT_BACKEND_MODEL: 'qwen3.7-max',
    }), [
      'npx',
      '--yes',
      'opencode-ai@1.18.5',
      'serve',
      '--hostname',
      '127.0.0.1',
      '--port',
      '4321',
    ])
  } finally {
    target.close()
  }
})

test('OpenClaw auto mode prefers the user-installed command', {
  skip: process.platform === 'win32',
}, () => {
  const target = fixture()
  try {
    command(resolve(target.bin, 'openclaw'), {
      version: 'OpenClaw 2026.6.33',
      captureModels: true,
    })
    command(resolve(target.bin, 'npx'))
    const userConfig = resolve(target.directory, 'user-openclaw.json')
    writeFileSync(userConfig, JSON.stringify({
      models: { providers: {} },
    }))
    assert.deepEqual(run('scripts/openclaw.mjs', target, {
      OPENCLAW_RUNTIME: 'auto',
      OPENCLAW_CONFIG_PATH: userConfig,
    }, ['gateway', 'run']).slice(0, 3), [
      'openclaw',
      'gateway',
      'run',
    ])
    assert.equal(
      readFileSync(target.capture, 'utf8').trim().split('\n').at(-2),
      `OPENCLAW_CONFIG_PATH=${resolve(
        target.directory,
        'config/backends/openclaw/state/gateway-18789/openclaw.json',
      )}`,
    )
    assert.equal(
      readFileSync(target.capture, 'utf8').trim().split('\n').at(-1),
      `OPENCLAW_STATE_DIR=${resolve(
        target.directory,
        'config/backends/openclaw/state/gateway-18789',
      )}`,
    )
    assert.equal(
      existsSync(resolve(
        target.directory,
        'config/backends/openclaw/openclaw.json5',
      )),
      false,
    )
    assert.equal(
      existsSync(resolve(
        target.directory,
        'config/workspaces/openclaw/AGENTS.md',
      )),
      false,
    )
  } finally {
    target.close()
  }
})

test('OpenClaw auto mode prefers an explicit enterprise bundle', {
  skip: process.platform === 'win32',
}, () => {
  const target = fixture()
  try {
    const bundle = resolve(target.directory, 'bundle-openclaw')
    command(bundle)
    command(resolve(target.bin, 'openclaw'), {
      version: 'OpenClaw 2026.6.33',
    })
    assert.deepEqual(run('scripts/openclaw.mjs', target, {
      OPENCLAW_RUNTIME: 'auto',
      OPENCLAW_BUNDLE_BIN: bundle,
    }, ['acp']), [
      'bundle-openclaw',
      'acp',
    ])
  } finally {
    target.close()
  }
})

test('OpenClaw auto mode preserves the user-installed version', {
  skip: process.platform === 'win32',
}, () => {
  const target = fixture()
  try {
    command(resolve(target.bin, 'openclaw'), {
      version: 'OpenClaw 2026.7.1-2',
    })
    const packageBinary = resolve(target.bin, 'openclaw-package')
    command(packageBinary)
    writeFileSync(resolve(target.bin, 'npx'), [
      '#!/bin/sh',
      'printf "%s\\n" "$FAKE_OPENCLAW_PACKAGE_BIN"',
      '',
    ].join('\n'))
    chmodSync(resolve(target.bin, 'npx'), 0o755)
    assert.deepEqual(run('scripts/openclaw.mjs', target, {
      OPENCLAW_RUNTIME: 'auto',
      FAKE_OPENCLAW_PACKAGE_BIN: packageBinary,
      DASHSCOPE_API_KEY: 'test-key',
      QWEN_AUDIO_AGENT_BACKEND_MODEL: 'qwen3.7-max',
      DASHSCOPE_API_KEY: 'test-key',
      QWEN_AUDIO_AGENT_BACKEND_MODEL: 'qwen3.7-max',
    }, ['acp']), [
      'openclaw',
      'acp',
    ])
  } finally {
    target.close()
  }
})

test('automatic fallback requires explicit Bailian setup', {
  skip: process.platform === 'win32',
}, () => {
  const openCode = fixture()
  const openClaw = fixture()
  try {
    command(resolve(openCode.bin, 'npx'))
    command(resolve(openClaw.bin, 'npx'))
    const openCodeResult = execute('scripts/opencode-server.mjs', openCode, {
      OPENCODE_RUNTIME: 'auto',
    })
    assert.notEqual(openCodeResult.status, 0)
    assert.match(openCodeResult.stderr, /requires DASHSCOPE_API_KEY/)

    const openClawResult = execute('scripts/openclaw.mjs', openClaw, {
      OPENCLAW_RUNTIME: 'auto',
    }, ['acp'])
    assert.notEqual(openClawResult.status, 0)
    assert.match(openClawResult.stderr, /requires DASHSCOPE_API_KEY/)
  } finally {
    openCode.close()
    openClaw.close()
  }
})

test('OpenClaw auto mode downloads a pinned package when missing', {
  skip: process.platform === 'win32',
}, () => {
  const target = fixture()
  try {
    const packageBinary = resolve(target.bin, 'openclaw-package')
    command(packageBinary)
    writeFileSync(resolve(target.bin, 'npx'), [
      '#!/bin/sh',
      'printf "%s\\n" "$FAKE_OPENCLAW_PACKAGE_BIN"',
      '',
    ].join('\n'))
    chmodSync(resolve(target.bin, 'npx'), 0o755)
    assert.deepEqual(run('scripts/openclaw.mjs', target, {
      OPENCLAW_RUNTIME: 'auto',
      FAKE_OPENCLAW_PACKAGE_BIN: packageBinary,
      DASHSCOPE_API_KEY: 'test-key',
      QWEN_AUDIO_AGENT_BACKEND_MODEL: 'qwen3.7-max',
    }, ['acp']), [
      'openclaw-package',
      'acp',
    ])
  } finally {
    target.close()
  }
})

test('package mode uses pinned, configurable npm package versions', {
  skip: process.platform === 'win32',
}, () => {
  const openCode = fixture()
  const openClaw = fixture()
  try {
    command(resolve(openCode.bin, 'npx'))
    const packageBinary = resolve(openClaw.bin, 'openclaw-package')
    command(packageBinary)
    const resolverCapture = `${openClaw.capture}.resolve`
    writeFileSync(resolve(openClaw.bin, 'npx'), [
      '#!/bin/sh',
      'printf "%s\\n" "$(basename "$0")" "$@" > "$RESOLVE_CAPTURE"',
      'printf "%s\\n" "$FAKE_OPENCLAW_PACKAGE_BIN"',
      '',
    ].join('\n'))
    chmodSync(resolve(openClaw.bin, 'npx'), 0o755)
    assert.deepEqual(run('scripts/opencode-server.mjs', openCode, {
      OPENCODE_RUNTIME: 'package',
      OPENCODE_PORT: '4321',
    }), [
      'npx',
      '--yes',
      'opencode-ai@1.18.5',
      'serve',
      '--hostname',
      '127.0.0.1',
      '--port',
      '4321',
    ])
    assert.deepEqual(run('scripts/openclaw.mjs', openClaw, {
      OPENCLAW_RUNTIME: 'package',
      RESOLVE_CAPTURE: resolverCapture,
      FAKE_OPENCLAW_PACKAGE_BIN: packageBinary,
    }, ['gateway', 'run']), [
      'openclaw-package',
      'gateway',
      'run',
    ])
    assert.deepEqual(
      readFileSync(resolverCapture, 'utf8').trim().split('\n'),
      [
        'npx',
        '--yes',
        '--package',
        'openclaw@2026.6.33',
        '--',
        'which',
        'openclaw',
      ],
    )
  } finally {
    openCode.close()
    openClaw.close()
  }
})

test('Codex ACP prefers an installed adapter and pins its package fallback', {
  skip: process.platform === 'win32',
}, () => {
  const binary = fixture()
  const packageRuntime = fixture()
  try {
    command(resolve(binary.bin, 'codex'))
    command(resolve(binary.bin, 'codex-acp'), {
      captureNativePaths: true,
    })
    command(resolve(packageRuntime.bin, 'codex'))
    command(resolve(packageRuntime.bin, 'npx'))
    const installed = run('scripts/codex-acp.mjs', binary, {
      CODEX_ACP_RUNTIME: 'auto',
    }, ['--help'])
    assert.deepEqual(installed.slice(0, 2), [
      'codex-acp',
      '--help',
    ])
    assert.equal(
      installed.at(-2),
      `CODEX_PATH=${resolve(binary.bin, 'codex')}`,
    )
    assert.deepEqual(run('scripts/codex-acp.mjs', packageRuntime, {
      CODEX_ACP_RUNTIME: 'package',
    }, ['--help']), [
      'npx',
      '-y',
      '@agentclientprotocol/codex-acp@1.1.7',
      '--help',
    ])
  } finally {
    binary.close()
    packageRuntime.close()
  }
})

test('Claude Code ACP prefers an installed adapter and pins its package fallback', {
  skip: process.platform === 'win32',
}, () => {
  const binary = fixture()
  const packageRuntime = fixture()
  try {
    command(resolve(binary.bin, 'claude'))
    command(resolve(binary.bin, 'claude-code-acp'), {
      captureNativePaths: true,
    })
    command(resolve(packageRuntime.bin, 'claude'))
    command(resolve(packageRuntime.bin, 'npx'))
    const installed = run('scripts/claude-code-acp.mjs', binary, {
      CLAUDE_CODE_ACP_RUNTIME: 'auto',
    }, ['--help'])
    assert.deepEqual(installed.slice(0, 2), [
      'claude-code-acp',
      '--help',
    ])
    assert.equal(
      installed.at(-1),
      `CLAUDE_CODE_EXECUTABLE=${resolve(binary.bin, 'claude')}`,
    )
    assert.deepEqual(run('scripts/claude-code-acp.mjs', packageRuntime, {
      CLAUDE_CODE_ACP_RUNTIME: 'package',
    }, ['--help']), [
      'npx',
      '-y',
      '@zed-industries/claude-code-acp@0.16.2',
      '--help',
    ])
  } finally {
    binary.close()
    packageRuntime.close()
  }
})

test('Pi ACP prefers an installed adapter and pins its package fallback', {
  skip: process.platform === 'win32',
}, () => {
  const binary = fixture()
  const packageRuntime = fixture()
  try {
    command(resolve(binary.bin, 'pi'))
    command(resolve(binary.bin, 'pi-acp'), {
      capturePiBin: true,
    })
    command(resolve(packageRuntime.bin, 'pi'))
    command(resolve(packageRuntime.bin, 'npx'))
    const installed = run('scripts/pi-acp.mjs', binary, {
      PI_ACP_RUNTIME: 'auto',
    }, ['--help'])
    assert.deepEqual(installed.slice(0, 2), [
      'pi-acp',
      '--help',
    ])
    // The adapter must receive the resolved pi executable through the
    // variable pi-acp actually reads (PI_ACP_PI_COMMAND), not only PI_BIN.
    assert.deepEqual(installed.slice(-2), [
      `PI_BIN=${resolve(binary.bin, 'pi')}`,
      `PI_ACP_PI_COMMAND=${resolve(binary.bin, 'pi')}`,
    ])
    // An explicit PI_BIN outside PATH is forwarded to the adapter verbatim.
    const explicit = run('scripts/pi-acp.mjs', binary, {
      PI_ACP_RUNTIME: 'auto',
      PI_BIN: '/opt/pi/bin/pi',
    }, ['--help'])
    assert.deepEqual(explicit.slice(-2), [
      'PI_BIN=/opt/pi/bin/pi',
      'PI_ACP_PI_COMMAND=/opt/pi/bin/pi',
    ])
    // A user-provided PI_ACP_PI_COMMAND takes precedence over PI_BIN.
    const overridden = run('scripts/pi-acp.mjs', binary, {
      PI_ACP_RUNTIME: 'auto',
      PI_BIN: '/opt/pi/bin/pi',
      PI_ACP_PI_COMMAND: '/usr/local/bin/pi',
    }, ['--help'])
    assert.equal(
      overridden.at(-1),
      'PI_ACP_PI_COMMAND=/usr/local/bin/pi',
    )
    assert.deepEqual(run('scripts/pi-acp.mjs', packageRuntime, {
      PI_ACP_RUNTIME: 'package',
    }, ['--help']), [
      'npx',
      '-y',
      'pi-acp@0.0.33',
      '--help',
    ])
  } finally {
    binary.close()
    packageRuntime.close()
  }
})

test('Pi ACP accepts its adapter-native Pi command without PATH discovery', {
  skip: process.platform === 'win32',
}, () => {
  const target = fixture()
  try {
    command(resolve(target.bin, 'pi-acp'), { capturePiBin: true })
    const result = run('scripts/pi-acp.mjs', target, {
      PI_ACP_RUNTIME: 'auto',
      PI_ACP_PI_COMMAND: '/opt/custom/pi',
    }, ['--help'])
    assert.deepEqual(result, [
      'pi-acp',
      '--help',
      'PI_BIN=/opt/custom/pi',
      'PI_ACP_PI_COMMAND=/opt/custom/pi',
    ])
  } finally {
    target.close()
  }
})

test('external ACP adapters require the user backend to be installed', {
  skip: process.platform === 'win32',
}, () => {
  const codex = fixture()
  const claude = fixture()
  const pi = fixture()
  try {
    command(resolve(codex.bin, 'codex-acp'))
    command(resolve(claude.bin, 'claude-code-acp'))
    command(resolve(pi.bin, 'pi-acp'))
    const codexResult = execute('scripts/codex-acp.mjs', codex, {
      CODEX_ACP_RUNTIME: 'auto',
    })
    assert.notEqual(codexResult.status, 0)
    assert.match(codexResult.stderr, /Codex is not installed/)
    const claudeResult = execute('scripts/claude-code-acp.mjs', claude, {
      CLAUDE_CODE_ACP_RUNTIME: 'auto',
    })
    assert.notEqual(claudeResult.status, 0)
    assert.match(claudeResult.stderr, /Claude Code is not installed/)
    const piResult = execute('scripts/pi-acp.mjs', pi, {
      PI_ACP_RUNTIME: 'auto',
    })
    assert.notEqual(piResult.status, 0)
    assert.match(piResult.stderr, /Pi is not installed/)
  } finally {
    codex.close()
    claude.close()
    pi.close()
  }
})

test('automatically configures explicit Bailian models for OpenCode and OpenClaw', {
  skip: process.platform === 'win32',
}, () => {
  const openCode = fixture()
  const openClaw = fixture()
  try {
    command(resolve(openCode.bin, 'opencode'), {
      version: '1.20.0',
      captureModels: true,
    })
    command(resolve(openClaw.bin, 'openclaw'), {
      version: 'OpenClaw 2026.6.33',
      captureModels: true,
    })
    const openCodeOutput = run('scripts/opencode-server.mjs', openCode, {
      DASHSCOPE_API_KEY: 'test-key',
      QWEN_AUDIO_AGENT_BACKEND_MODEL: 'qwen-custom',
    })
    assert.equal(openCodeOutput.at(-5), 'OPENCODE_MODEL=alibaba-cn/qwen-custom')

    const openClawOutput = run('scripts/openclaw.mjs', openClaw, {
      DASHSCOPE_API_KEY: 'test-key',
      QWEN_AUDIO_AGENT_BACKEND_MODEL: 'qwen-custom',
    }, ['gateway', 'run'])
    assert.deepEqual(openClawOutput.slice(-5), [
      'OPENCODE_MODEL=',
      'OPENCLAW_MODEL=bailian/qwen-custom',
      'OPENCLAW_MODEL_ID=qwen-custom',
      `OPENCLAW_CONFIG_PATH=${resolve(
        openClaw.directory,
        'config/backends/openclaw/openclaw.json5',
      )}`,
      `OPENCLAW_STATE_DIR=${resolve(
        openClaw.directory,
        'config/backends/openclaw/state/gateway-18789',
      )}`,
    ])
    assert.equal(existsSync(resolve(
      openClaw.directory,
      'config/backends/openclaw/openclaw.json5',
    )), true)
  } finally {
    openCode.close()
    openClaw.close()
  }
})

test('preserves native OpenCode and OpenClaw configuration without a model override', {
  skip: process.platform === 'win32',
}, () => {
  const openCode = fixture()
  const openClaw = fixture()
  try {
    command(resolve(openCode.bin, 'opencode'), {
      version: '1.20.0',
      captureModels: true,
    })
    command(resolve(openClaw.bin, 'openclaw'), {
      version: 'OpenClaw 2026.6.33',
      captureModels: true,
    })
    assert.equal(
      run('scripts/opencode-server.mjs', openCode, {
        DASHSCOPE_API_KEY: 'test-key',
      }).at(-5),
      'OPENCODE_MODEL=',
    )
    assert.deepEqual(run('scripts/openclaw.mjs', openClaw, {
      DASHSCOPE_API_KEY: 'test-key',
    }, ['gateway', 'run']).slice(-5), [
      'OPENCODE_MODEL=',
      'OPENCLAW_MODEL=',
      'OPENCLAW_MODEL_ID=',
      'OPENCLAW_CONFIG_PATH=',
      `OPENCLAW_STATE_DIR=${resolve(
        openClaw.directory,
        'config/backends/openclaw/state/gateway-18789',
      )}`,
    ])
  } finally {
    openCode.close()
    openClaw.close()
  }
})

test('isolates OpenClaw sessions while reusing user capability configuration', {
  skip: process.platform === 'win32',
}, () => {
  const target = fixture()
  try {
    command(resolve(target.bin, 'openclaw'), {
      version: 'OpenClaw 2026.6.33',
      captureModels: true,
    })
    const userState = resolve(target.directory, '.openclaw')
    mkdirSync(resolve(userState, 'extensions'), { recursive: true })
    mkdirSync(resolve(userState, 'skills'), { recursive: true })
    writeFileSync(resolve(userState, 'openclaw.json'), JSON.stringify({
      models: { providers: { user: { models: [] } } },
    }))

    const output = run('scripts/openclaw.mjs', target, {
      DASHSCOPE_API_KEY: 'test-key',
      OPENCLAW_PORT: '43210',
    }, ['gateway', 'run'])
    const runtimeState = resolve(
      target.directory,
      'config/backends/openclaw/state/gateway-43210',
    )
    assert.equal(
      output.at(-2),
      `OPENCLAW_CONFIG_PATH=${resolve(
        runtimeState,
        'openclaw.json',
      )}`,
    )
    assert.equal(output.at(-1), `OPENCLAW_STATE_DIR=${runtimeState}`)
    const isolatedConfig = JSON.parse(readFileSync(
      resolve(runtimeState, 'openclaw.json'),
      'utf8',
    ))
    assert.deepEqual(isolatedConfig.models, {
      providers: { user: { models: [] } },
    })
    assert.equal('channels' in isolatedConfig, false)
    for (const directory of ['extensions', 'skills']) {
      const link = resolve(runtimeState, directory)
      assert.equal(lstatSync(link).isSymbolicLink(), true)
      assert.equal(readlinkSync(link), resolve(userState, directory))
    }
  } finally {
    target.close()
  }
})
