import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import {
  NativeInputFrameDecoder,
  encodeNativeInputFrame,
} from '../src/native-input-protocol.mjs'

const root = resolve(new URL('../..', import.meta.url).pathname)

test('real signed Bridge and IME accept only their exact peer identifiers', {
  skip: process.platform !== 'darwin',
  timeout: 30_000,
}, async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'qwen-native-xpc-'))
  const output = join(workspace, 'build')
  const runtime = join(workspace, 'runtime')
  let bridge
  try {
    const build = spawnSync(process.execPath, [
      'scripts/build-native-input.mjs',
      '--configuration', 'Debug',
      '--arch', 'current',
      '--output', output,
    ], { cwd: root, encoding: 'utf8' })
    assert.equal(build.status, 0, build.stderr || build.stdout)

    const bridgePath = join(output, 'QwenInputBridge')
    const inputApp = join(output, 'Qwen Input.app')
    const inputExecutable = join(inputApp, 'Contents/MacOS/Qwen Input')
    const socketPath = join(runtime, 'control.sock')
    bridge = spawn(bridgePath, ['--peer-probe-listen', runtime], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const bridgeMessages = new NativeInputFrameDecoder()
    const ready = await nextMessage(bridge.stdout, bridgeMessages)
    assert.deepEqual(ready, { state: 'ready', type: 'bridge.ready' })

    const accepted = spawnSync(inputExecutable, ['--peer-probe', socketPath], {
      encoding: 'utf8',
      timeout: 3_000,
    })
    assert.equal(accepted.status, 0, accepted.stderr || accepted.error?.message)

    const wrongApp = join(workspace, 'Wrong Input.app')
    cpSync(inputApp, wrongApp, { recursive: true })
    const resign = spawnSync('codesign', [
      '--force', '--deep', '--sign', '-',
      '--identifier', 'ai.qwenaudio.agent.wrong-input',
      wrongApp,
    ], { encoding: 'utf8' })
    assert.equal(resign.status, 0, resign.stderr)
    const rejected = spawnSync(
      join(wrongApp, 'Contents/MacOS/Qwen Input'),
      ['--peer-probe', socketPath],
      { encoding: 'utf8', timeout: 3_000 },
    )
    assert.notEqual(rejected.status, 0, 'wrong-bundle peer was accepted')

    bridge.stdin.end(encodeNativeInputFrame({ type: 'bridge.stop' }))
    const exit = await waitForExit(bridge)
    assert.equal(exit.code, 0, readFileSyncSafe(bridge.stderr))
    bridge = undefined
  } finally {
    bridge?.kill('SIGTERM')
    rmSync(workspace, { recursive: true, force: true })
  }
})

function nextMessage(stream, decoder) {
  return new Promise((resolveMessage, reject) => {
    const onData = chunk => {
      try {
        const messages = decoder.push(chunk)
        if (messages.length === 0) return
        cleanup()
        resolveMessage(messages[0])
      } catch (error) {
        cleanup()
        reject(error)
      }
    }
    const onEnd = () => {
      cleanup()
      reject(new Error('Bridge exited before sending ready'))
    }
    const cleanup = () => {
      stream.off('data', onData)
      stream.off('end', onEnd)
    }
    stream.on('data', onData)
    stream.on('end', onEnd)
  })
}

function waitForExit(child) {
  return new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolveExit({ code, signal }))
  })
}

function readFileSyncSafe(stream) {
  try {
    return readFileSync(stream.fd, 'utf8')
  } catch {
    return 'Bridge failed'
  }
}
