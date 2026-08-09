import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import {
  GATEWAY_SERVICE_LABEL,
  gatewayServiceDefinition,
  manageGatewayService,
} from '../src/gateway-service.mjs'

function temporaryDirectory() {
  return mkdtempSync(resolve(tmpdir(), 'qwen-audio-agent-service-'))
}

test('builds a launchd user service that runs the Gateway in foreground', () => {
  const root = temporaryDirectory()
  try {
    const definition = gatewayServiceDefinition({
      platform: 'darwin',
      homeDirectory: root,
      configDirectory: resolve(root, 'config'),
      nodePath: '/opt/node',
      gatewayPath: '/opt/server/index.mjs',
      pathEnvironment: '/opt/bin:/usr/bin',
      serviceEnvironment: { PORT: '3199' },
      serviceMetadata: { url: 'http://127.0.0.1:3199' },
    })
    assert.match(definition.content, new RegExp(GATEWAY_SERVICE_LABEL))
    assert.match(definition.content, /<string>\/opt\/server\/index.mjs<\/string>/)
    assert.match(definition.content, /<key>KeepAlive<\/key>/)
    assert.match(definition.content, /<key>RunAtLoad<\/key>/)
    assert.match(
      definition.content,
      /<key>WorkingDirectory<\/key>\s*<string>\/opt\/server<\/string>/,
    )
    assert.match(definition.content, /<key>PORT<\/key>\s*<string>3199<\/string>/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('installs and stops a launchd user service', async () => {
  const root = temporaryDirectory()
  const calls = []
  let loaded = false
  const execute = async (command, args) => {
    calls.push([command, ...args])
    if (args[0] === 'print' && !loaded) throw new Error('not loaded')
    if (args[0] === 'bootstrap') loaded = true
    if (args[0] === 'bootout') loaded = false
    return { stdout: '', stderr: '' }
  }
  const options = {
    platform: 'darwin',
    homeDirectory: root,
    configDirectory: resolve(root, 'config'),
    nodePath: '/opt/node',
    gatewayPath: '/opt/server/index.mjs',
    uid: 501,
    execute,
  }
  try {
    const installed = await manageGatewayService('install', options)
    assert.equal(installed.running, true)
    assert.deepEqual(installed.installedMetadata, {})
    assert.match(readFileSync(installed.servicePath, 'utf8'), /gateway/)
    assert.ok(calls.some(call => call.includes('bootstrap')))

    const stopped = await manageGatewayService('stop', options)
    assert.equal(stopped.running, false)
    assert.ok(calls.some(call => call.includes('bootout')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('installs a systemd user service with restart protection', async () => {
  const root = temporaryDirectory()
  const calls = []
  const options = {
    platform: 'linux',
    xdgConfigHome: resolve(root, 'xdg'),
    configDirectory: resolve(root, 'config'),
    nodePath: '/usr/bin/node',
    gatewayPath: '/opt/server/index.mjs',
    execute: async (command, args) => {
      calls.push([command, ...args])
      return { stdout: '', stderr: '' }
    },
  }
  try {
    const installed = await manageGatewayService('install', options)
    assert.equal(
      installed.servicePath,
      resolve(
        root,
        'xdg/systemd/user/qwen-audio-agent-gateway.service',
      ),
    )
    const unit = readFileSync(installed.servicePath, 'utf8')
    assert.match(unit, /ExecStart="\/usr\/bin\/node"/)
    assert.match(unit, /"\/opt\/server\/index.mjs"/)
    assert.match(unit, /WorkingDirectory=\/opt\/server/)
    assert.match(unit, /Restart=on-failure/)
    assert.deepEqual(calls.at(-1), [
      'systemctl',
      '--user',
      'enable',
      '--now',
      'qwen-audio-agent-gateway.service',
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
