import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { main } from '../src/launcher.mjs'

function harness({ ownsProcesses = false } = {}) {
  const calls = []
  const runtime = {
    ownsProcesses,
    close: signal => calls.push(['runtime.close', signal]),
    wait: async () => 17,
  }
  return {
    calls,
    dependencies: {
      env: { AGENT_PROTOCOL: 'opencode' },
      stdout: { write: value => calls.push(['stdout', value]) },
      signalSource: new EventEmitter(),
      prepareEnvironment: () => ({
        configDirectory: '/home/user/.config/qwaudio',
        configPath: '/home/user/.config/qwaudio/config.env',
      }),
      inspectSetups: options => {
        calls.push(['setup', options])
        return {
          selected: options.backend,
          readOnly: true,
          backends: [{
            id: options.backend || 'opencode',
            label: 'OpenCode',
            selected: true,
            ready: true,
            backend: {
              ready: true,
              source: 'installed',
              path: '/bin/opencode',
            },
            adapter: { ready: true, source: 'native' },
            integration: 'native',
            configuration: 'preserved',
            authentication: 'backend-managed',
            issues: [],
          }],
        }
      },
      acquireInstance: () => ({
        release: () => calls.push(['instance.release']),
      }),
      prepareRuntime: async options => {
        calls.push(['runtime', options])
        return runtime
      },
      inspectGateway: async () => ({
        backend: { kind: 'opencode', ok: true },
      }),
      manageService: async action => {
        calls.push(['service', action])
        return {
          installed: true,
          running: action !== 'stop' && action !== 'uninstall',
          logPath: '/home/user/.config/qwaudio/logs/gateway.log',
        }
      },
      waitForService: async url => {
        calls.push(['service.ready', url])
        return { backend: { kind: 'opencode', ok: true } }
      },
      waitForServiceStop: async url => {
        calls.push(['service.stopped', url])
      },
      runMinimalTui: async options => {
        calls.push(['minimal', options])
        return 11
      },
      runWebUi: async options => {
        calls.push(['webui', options])
        return 13
      },
    },
  }
}

test('starts the Gateway by default without acquiring a UI lock', async () => {
  const target = harness()
  assert.equal(await main([], target.dependencies), 0)
  assert.deepEqual(target.calls.map(call => call[0]), [
    'runtime',
    'stdout',
  ])
})

test('--backend none overrides a configured backend with frontend-only mode', async () => {
  const target = harness()
  target.dependencies.prepareRuntime = async options => {
    target.calls.push([
      'runtime',
      options,
      target.dependencies.env.AGENT_PROTOCOL,
    ])
    return {
      ownsProcesses: false,
      close: () => {},
      wait: async () => 0,
    }
  }
  assert.equal(
    await main(['gateway', '--backend', 'none'], target.dependencies),
    0,
  )
  assert.equal(
    target.calls.find(call => call[0] === 'runtime')[2],
    '',
  )
})

test('keeps an owned Gateway in the foreground', async () => {
  const target = harness({ ownsProcesses: true })
  assert.equal(await main(['gateway'], target.dependencies), 17)
  assert.deepEqual(
    target.calls.filter(call => call[0] === 'runtime.close').at(-1),
    ['runtime.close', undefined],
  )
})

test('stops an owned Gateway when its terminal closes', async () => {
  const target = harness({ ownsProcesses: true })
  let finishWait
  target.dependencies.prepareRuntime = async options => {
    target.calls.push(['runtime', options])
    return {
      ownsProcesses: true,
      close: signal => target.calls.push(['runtime.close', signal]),
      wait: () => new Promise(resolve => {
        finishWait = resolve
      }),
    }
  }

  const running = main(['gateway'], target.dependencies)
  await new Promise(resolve => setImmediate(resolve))
  target.dependencies.signalSource.emit('SIGHUP')
  assert.deepEqual(
    target.calls.filter(call => call[0] === 'runtime.close').at(-1),
    ['runtime.close', 'SIGTERM'],
  )
  finishWait(0)
  assert.equal(await running, 0)
})

test('remembers terminal closure while an owned Gateway is starting', async () => {
  const target = harness({ ownsProcesses: true })
  let finishStart
  let finishWait
  const runtime = {
    ownsProcesses: true,
    close: signal => target.calls.push(['runtime.close', signal]),
    wait: () => new Promise(resolve => {
      finishWait = resolve
    }),
  }
  target.dependencies.prepareRuntime = options => {
    target.calls.push(['runtime', options])
    return new Promise(resolve => {
      finishStart = () => resolve(runtime)
    })
  }

  const running = main(['gateway'], target.dependencies)
  await new Promise(resolve => setImmediate(resolve))
  target.dependencies.signalSource.emit('SIGHUP')
  finishStart()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(
    target.calls.filter(call => call[0] === 'runtime.close').at(-1),
    ['runtime.close', 'SIGTERM'],
  )
  finishWait(0)
  assert.equal(await running, 0)
  assert.equal(
    target.calls.some(call => call[0] === 'stdout'),
    false,
  )
})

test('stops an owned Gateway if its launcher exits unexpectedly', async () => {
  const target = harness({ ownsProcesses: true })
  let finishWait
  target.dependencies.prepareRuntime = async options => {
    target.calls.push(['runtime', options])
    return {
      ownsProcesses: true,
      close: signal => target.calls.push(['runtime.close', signal]),
      wait: () => new Promise(resolve => {
        finishWait = resolve
      }),
    }
  }

  const running = main(['gateway'], target.dependencies)
  await new Promise(resolve => setImmediate(resolve))
  target.dependencies.signalSource.emit('exit')
  assert.deepEqual(
    target.calls.filter(call => call[0] === 'runtime.close').at(-1),
    ['runtime.close', 'SIGTERM'],
  )
  finishWait(0)
  assert.equal(await running, 0)
})

test('installs, stops and reports the background Gateway service', async () => {
  const install = harness()
  assert.equal(
    await main(['gateway', 'install'], install.dependencies),
    0,
  )
  assert.deepEqual(install.calls.map(call => call[0]), [
    'service',
    'service',
    'service.ready',
    'stdout',
    'stdout',
  ])

  const stop = harness()
  assert.equal(await main(['gateway', 'stop'], stop.dependencies), 0)
  assert.deepEqual(stop.calls.map(call => call[0]), [
    'service',
    'service',
    'service.stopped',
    'stdout',
    'stdout',
  ])

  const status = harness()
  assert.equal(await main(['gateway', 'status'], status.dependencies), 0)
  assert.deepEqual(status.calls.map(call => call[0]), [
    'service',
    'stdout',
  ])
})

test('passes the configured local Gateway host and port to its service', async () => {
  const target = harness()
  target.dependencies.env.QWEN_AUDIO_AGENT_URL = 'http://127.0.0.1:3200'
  target.dependencies.manageService = async (action, options) => {
    target.calls.push(['service', action, options])
    return {
      installed: true,
      running: true,
      logPath: null,
    }
  }

  assert.equal(
    await main(['gateway', 'install'], target.dependencies),
    0,
  )
  const install = target.calls.find(call => (
    call[0] === 'service' && call[1] === 'install'
  ))
  assert.deepEqual(install[2].serviceEnvironment, {
    HOST: '127.0.0.1',
    PORT: '3200',
  })
})

test('rejects a remote Gateway URL for the local background service', async () => {
  const target = harness()
  target.dependencies.env.QWEN_AUDIO_AGENT_URL = 'https://voice.example.com'

  await assert.rejects(
    main(['gateway', 'install'], target.dependencies),
    /只支持本机 HTTP 地址/,
  )
  assert.equal(
    target.calls.some(call => call[0] === 'service'),
    false,
  )
})

test('does not confuse a foreground Gateway with the background service', async () => {
  const restart = harness()
  restart.dependencies.manageService = async action => {
    restart.calls.push(['service', action])
    return { installed: true, running: false }
  }
  await assert.rejects(
    main(['gateway', 'restart'], restart.dependencies),
    /正在前台运行/,
  )
  assert.deepEqual(restart.calls.map(call => call[0]), ['service'])

  const uninstall = harness()
  uninstall.dependencies.manageService = async action => {
    uninstall.calls.push(['service', action])
    return {
      installed: action !== 'uninstall',
      running: false,
    }
  }
  assert.equal(
    await main(['gateway', 'uninstall'], uninstall.dependencies),
    0,
  )
  assert.equal(
    uninstall.calls.some(call => call[0] === 'service.stopped'),
    false,
  )
})

test('connects TUI and WebUI without starting services', async () => {
  const tui = harness()
  assert.equal(
    await main(['tui', '--audio-mode', 'full'], tui.dependencies),
    11,
  )
  assert.deepEqual(tui.calls.map(call => call[0]), [
    'minimal',
    'instance.release',
  ])
  assert.equal(tui.calls[0][1].audioMode, 'full')

  const web = harness()
  assert.equal(await main(['webui'], web.dependencies), 13)
  assert.deepEqual(web.calls.map(call => call[0]), ['webui'])
})

test('requires a running Gateway for client commands', async () => {
  const target = harness()
  target.dependencies.inspectGateway = async () => null
  await assert.rejects(main(['tui'], target.dependencies), /请先执行/)
  assert.deepEqual(target.calls, [])
})

test('prints status and configuration without starting a service', async () => {
  const status = harness()
  assert.equal(await main(['status'], status.dependencies), 0)
  assert.deepEqual(status.calls.map(call => call[0]), ['service', 'stdout'])

  const config = harness()
  assert.equal(await main(['config'], config.dependencies), 0)
  assert.deepEqual(config.calls, [[
    'stdout',
    '/home/user/.config/qwaudio/config.env\n',
  ]])
})

test('installs a backend through the injected installer', async () => {
  const target = harness()
  let preparation
  target.dependencies.prepareEnvironment = options => {
    preparation = options
    return {
      configDirectory: '/home/user/.config/qwaudio',
      configPath: '/home/user/.config/qwaudio/config.env',
    }
  }
  target.dependencies.runInstaller = async (id, options) => {
    target.calls.push(['install', id])
    options.onProgress({ phase: 'start', title: '步骤 1', display: 'npm i -g x' })
    options.onProgress({ phase: 'output', chunk: 'added 1 package\n' })
    return { ok: true, loginHint: '请在终端登录' }
  }
  assert.equal(await main(['install', 'codex'], target.dependencies), 0)
  assert.deepEqual(preparation, { readOnly: true })
  assert.deepEqual(target.calls.map(call => call[0]), [
    'install',
    'stdout',
    'stdout',
    'stdout',
    'stdout',
  ])
  const output = target.calls
    .filter(call => call[0] === 'stdout')
    .map(call => call[1])
    .join('')
  assert.match(output, /步骤 1：npm i -g x/)
  assert.match(output, /added 1 package/)
  assert.match(output, /✓ Codex 安装完成/)
  assert.match(output, /请在终端登录/)
})

test('asks before running script install steps unless --yes is given', async () => {
  const declined = harness()
  const decliningInput = new PassThrough()
  decliningInput.end('n\n')
  declined.dependencies.stdin = decliningInput
  declined.dependencies.runInstaller = async (id, options) => {
    const confirmed = await options.confirmStep({
      display: 'curl -fsSL https://example.com/install.sh | bash',
    })
    return confirmed
      ? { ok: true }
      : { ok: false, error: { code: 'DECLINED', message: '已取消安装' } }
  }
  assert.equal(await main(['install', 'hermes'], declined.dependencies), 1)
  const declinedOutput = declined.calls
    .filter(call => call[0] === 'stdout')
    .map(call => call[1])
    .join('')
  assert.match(declinedOutput, /即将执行官方安装脚本/)
  assert.match(declinedOutput, /✗ Hermes 安装未完成：已取消安装/)

  const assumed = harness()
  assumed.dependencies.runInstaller = async (id, options) => {
    assumed.calls.push(['confirmed', await options.confirmStep({ display: 'x' })])
    return { ok: true }
  }
  assert.equal(
    await main(['install', 'hermes', '--yes'], assumed.dependencies),
    0,
  )
  assert.deepEqual(assumed.calls.filter(call => call[0] === 'confirmed'), [[
    'confirmed',
    true,
  ]])
})

test('reports an already installed backend without rerunning steps', async () => {
  const target = harness()
  target.dependencies.runInstaller = async () => ({
    ok: true,
    alreadyInstalled: true,
    loginHint: '请在终端登录',
  })
  assert.equal(await main(['install', 'codex'], target.dependencies), 0)
  const output = target.calls
    .filter(call => call[0] === 'stdout')
    .map(call => call[1])
    .join('')
  assert.match(output, /✓ Codex 已安装/)
  assert.doesNotMatch(output, /步骤/)
})

test('reports installer failures with a non-zero exit code', async () => {
  const target = harness()
  target.dependencies.runInstaller = async () => ({
    ok: false,
    error: { code: 'NPM_MISSING', message: '未找到 npm' },
  })
  assert.equal(await main(['install', 'qoder'], target.dependencies), 1)
  const output = target.calls
    .filter(call => call[0] === 'stdout')
    .map(call => call[1])
    .join('')
  assert.match(output, /✗ Qoder 安装未完成：未找到 npm/)
})

test('prints a reusable read-only backend setup report', async () => {
  const target = harness()
  let preparation
  target.dependencies.prepareEnvironment = options => {
    preparation = options
    return {
      configDirectory: '/home/user/.config/qwaudio',
      configPath: '/home/user/.config/qwaudio/config.env',
    }
  }
  assert.equal(
    await main(['setup', '--backend', 'opencode'], target.dependencies),
    0,
  )
  assert.deepEqual(preparation, { readOnly: true })
  assert.deepEqual(target.calls.map(call => call[0]), ['setup', 'stdout'])
  assert.match(target.calls[1][1], /默认不覆盖后台模型/)

  const json = harness()
  assert.equal(
    await main([
      'setup',
      '--backend', 'opencode',
      '--json',
    ], json.dependencies),
    0,
  )
  assert.equal(JSON.parse(json.calls[1][1]).readOnly, true)
})
