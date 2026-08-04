import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'

const SESSION_TOKEN = '41'.repeat(32)

function lineInbox(stream) {
  let buffered = ''
  const queued = []
  const waiters = []
  const seen = []
  stream.on('data', chunk => {
    buffered += chunk.toString('utf8')
    let newline = buffered.indexOf('\n')
    while (newline >= 0) {
      const line = buffered.slice(0, newline)
      buffered = buffered.slice(newline + 1)
      if (line) {
        const message = JSON.parse(line)
        seen.push(message)
        const waiter = waiters.shift()
        if (waiter) waiter.resolve(message)
        else queued.push(message)
      }
      newline = buffered.indexOf('\n')
    }
  })
  return {
    seen,
    next(timeoutMs = 2_000) {
      if (queued.length) return Promise.resolve(queued.shift())
      return new Promise((resolvePromise, rejectPromise) => {
        const waiter = {
          resolve: value => {
            clearTimeout(timer)
            resolvePromise(value)
          },
        }
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter)
          if (index >= 0) waiters.splice(index, 1)
          rejectPromise(new Error('Timed out waiting for desktop-host output'))
        }, timeoutMs)
        waiters.push(waiter)
      })
    },
    async nextMatching(predicate, timeoutMs = 2_000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const message = await this.next(Math.max(1, deadline - Date.now()))
        if (predicate(message)) return message
      }
      throw new Error('Timed out waiting for matching desktop-host output')
    },
  }
}

test('runs the CLI desktop-host protocol against a temporary WSL-like home', {
  timeout: 15_000,
}, async () => {
  const home = await mkdtemp(resolve(tmpdir(), 'qwaudio-desktop-host-'))
  const child = spawn(process.execPath, [
    resolve('cli/bin/qwenaudio.mjs'),
    'desktop-host',
  ], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      HOME: home,
      QWAUDIO_CONFIG_DIR: resolve(home, '.config/qwaudio'),
      WSL_DISTRO_NAME: 'Ubuntu-Test',
      QWEN_AUDIO_DESKTOP_SESSION_TOKEN: SESSION_TOKEN,
      QWEN_AUDIO_DESKTOP_HOST_DISABLE_GATEWAY: '1',
      NODE_ENV: 'test',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const inbox = lineInbox(child.stdout)
  const diagnostics = []
  child.stderr.on('data', chunk => diagnostics.push(chunk.toString('utf8')))
  try {
    const hello = await inbox.next(10_000)
    assert.equal(hello.event, 'hello')
    assert.equal(hello.data.protocol, 1)
    assert.equal(hello.data.packageVersion, '1.2.0')
    assert.equal(hello.data.distribution, 'Ubuntu-Test')

    child.stdin.write(
      '{"id":"status","method":"runtime.status","params":{}}\n',
    )
    const status = await inbox.nextMatching(message => message.id === 'status')
    assert.equal(status.ok, true)

    child.stdin.write(`${JSON.stringify({
      id: 'shutdown',
      method: 'host.shutdown',
      params: { sessionToken: SESSION_TOKEN },
    })}\n`)
    const shutdown = await inbox.nextMatching(
      message => message.id === 'shutdown',
    )
    assert.equal(shutdown.ok, true)
    const [code, signal] = await once(child, 'exit')
    assert.equal(code, 0)
    assert.equal(signal, null)
    assert.doesNotMatch(
      JSON.stringify(inbox.seen) + diagnostics.join(''),
      new RegExp(SESSION_TOKEN),
    )
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await rm(home, { recursive: true, force: true })
  }
})
