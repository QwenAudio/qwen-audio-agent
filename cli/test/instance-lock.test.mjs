import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { acquireCliInstance } from '../src/instance-lock.mjs'

test('allows only one live CLI instance', () => {
  const directory = mkdtempSync(join(tmpdir(), 'qwenaudio-cli-lock-'))
  const first = acquireCliInstance(directory, {
    pid: 101,
    token: 'first',
    killImpl: pid => {
      if (pid === 101) return
      throw Object.assign(new Error('missing'), { code: 'ESRCH' })
    },
  })

  assert.throws(
    () => acquireCliInstance(directory, {
      pid: 202,
      token: 'second',
      killImpl: pid => {
        if (pid === 101) return
        throw Object.assign(new Error('missing'), { code: 'ESRCH' })
      },
    }),
    /另一个 qwenaudio CLI 已在运行/,
  )

  first.release()
  const second = acquireCliInstance(directory, {
    pid: 202,
    token: 'second',
    killImpl: () => {},
  })
  second.release()
})

test('recovers a stale CLI lock without deleting a replacement lock', () => {
  const directory = mkdtempSync(join(tmpdir(), 'qwenaudio-cli-stale-'))
  const path = join(directory, 'cli.lock')
  writeFileSync(path, JSON.stringify({ pid: 99, token: 'stale' }))
  const lock = acquireCliInstance(directory, {
    pid: 303,
    token: 'current',
    killImpl: () => {
      throw Object.assign(new Error('missing'), { code: 'ESRCH' })
    },
  })
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).token, 'current')

  writeFileSync(path, JSON.stringify({ pid: 404, token: 'replacement' }))
  lock.release()
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).token, 'replacement')
})

test('client-owned locks retain separate instances for separate Gateway profiles', t => {
  const root = mkdtempSync(join(tmpdir(), 'qwenaudio-client-locks-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const clientDir = join(root, 'client')
  const first = acquireCliInstance(clientDir, { instanceKey: '/gateway-a/state' })
  const second = acquireCliInstance(clientDir, { instanceKey: '/gateway-b/state' })
  assert.notEqual(first.path, second.path)
  assert.equal(existsSync(first.path), true)
  assert.equal(existsSync(second.path), true)
  assert.throws(() => acquireCliInstance(clientDir, { instanceKey: '/gateway-a/state' }), /CLI/)
  first.release()
  second.release()
  assert.equal(existsSync(first.path), false)
  assert.equal(existsSync(second.path), false)
})
