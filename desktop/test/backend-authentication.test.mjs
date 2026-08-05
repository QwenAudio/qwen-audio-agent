import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import {
  openBackendAuthentication,
  terminalLaunch,
} from '../src/backend-authentication.mjs'

test('opens a fixed backend-owned authentication command in Terminal', () => {
  const launch = terminalLaunch('qoder', { env: {}, platform: 'darwin' })
  assert.equal(launch.command, '/usr/bin/osascript')
  assert.match(launch.args.join(' '), /qodercli login/)
  const codebuddy = terminalLaunch('codebuddy', {
    env: {},
    platform: 'darwin',
  })
  assert.match(codebuddy.args.join(' '), /codebuddy/)
})

test('launches authentication detached without accepting a renderer command', async () => {
  const calls = []
  let unref = false
  assert.equal(await openBackendAuthentication('codex', {
    env: {},
    platform: 'darwin',
    spawnImpl: (...args) => {
      calls.push(args)
      const child = new EventEmitter()
      child.unref = () => { unref = true }
      queueMicrotask(() => child.emit('spawn'))
      return child
    },
  }), true)
  assert.match(calls[0][1].join(' '), /codex login/)
  assert.equal(calls[0][2].detached, true)
  assert.equal(unref, true)
})

test('reports when the official authentication terminal cannot open', async () => {
  await assert.rejects(openBackendAuthentication('kimi', {
    env: {},
    platform: 'linux',
    spawnImpl: () => {
      const child = new EventEmitter()
      queueMicrotask(() => child.emit('error', new Error('terminal unavailable')))
      return child
    },
  }), /terminal unavailable/)
})
