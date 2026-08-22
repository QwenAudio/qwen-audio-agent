import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import {
  mkdtempSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, test } from 'node:test'

import { NativeInputHost } from '../src/native-input-host.mjs'
import {
  NativeInputFrameDecoder,
  encodeNativeInputFrame,
} from '../src/native-input-protocol.mjs'

const root = resolve(new URL('../..', import.meta.url).pathname)
let workspace
let output
let bridgePath
let inputExecutable
const isMacOS = process.platform === 'darwin'

before(() => {
  if (!isMacOS) return
  workspace = mkdtempSync(join(tmpdir(), 'qwen-native-input-process-'))
  output = join(workspace, 'build')
  const build = spawnSync(process.execPath, [
    'scripts/build-native-input.mjs',
    '--configuration', 'Debug',
    '--arch', 'current',
    '--output', output,
  ], { cwd: root, encoding: 'utf8' })
  assert.equal(build.status, 0, build.stderr || build.stdout)
  bridgePath = join(output, 'QwenInputBridge')
  inputExecutable = join(output, 'Qwen Input.app/Contents/MacOS/Qwen Input')
})

after(() => {
  if (!isMacOS) return
  rmSync(workspace, { recursive: true, force: true })
})

test('real Bridge handles fake lifecycle frames and exits without residue', {
  skip: !isMacOS,
  timeout: 15_000,
}, async () => {
  const beforeFiles = snapshotFiles(workspace)
  const emergencyStops = []
  const host = new NativeInputHost({
    resolveArtifact: () => bridgePath,
    environment: {
      PATH: process.env.PATH,
      TMPDIR: workspace,
      LANG: 'en_US.UTF-8',
      QWEN_AUDIO_DICTATION_API_KEY: 'must-not-cross',
    },
    onEmergencyStop: reason => emergencyStops.push(reason),
  })

  await host.start()
  assert.equal(host.state, 'ready')

  await sendAndExpect(host, {
    type: 'session.arm',
  }, 'ready')
  await sendAndExpect(host, {
    type: 'session.partial',
    text: 'A😀B',
  }, 'transcribing')
  await sendAndExpect(host, {
    type: 'session.final',
    text: 'é 你好',
  }, 'ready-to-send')
  await sendAndExpect(host, {
    type: 'session.pause',
  }, 'paused')
  await sendAndExpect(host, {
    type: 'session.resume',
  }, 'listening')
  await sendAndExpect(host, {
    type: 'session.cancel',
  }, 'cancelled')

  const child = host.child
  const exited = once(child, 'exit')
  await host.stop('phase0_gate')
  const [code, signal] = await exited
  assert.equal(code, 0)
  assert.equal(signal, null)
  assert.equal(host.state, 'idle')
  assert.deepEqual(emergencyStops, [])
  assert.deepEqual(snapshotFiles(workspace), beforeFiles)
})

test('real Bridge reports a malformed frame and fails closed', {
  skip: !isMacOS,
  timeout: 15_000,
}, async () => {
  const child = spawn(bridgePath, [], {
    env: { PATH: process.env.PATH, TMPDIR: workspace },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const decoder = new NativeInputFrameDecoder()
  assert.deepEqual(await nextMessage(child.stdout, decoder), {
    state: 'ready',
    type: 'bridge.ready',
  })

  const exited = once(child, 'exit')
  child.stdin.write(Buffer.from([0, 0, 0, 0]))
  assert.deepEqual(await nextMessage(child.stdout, decoder), {
    reason: 'zeroLength',
    state: 'error',
    type: 'bridge.error',
  })
  const [code] = await exited
  assert.notEqual(code, 0)
})

test('real Bridge treats control-pipe EOF as a clean shutdown', {
  skip: !isMacOS,
  timeout: 15_000,
}, async () => {
  const child = spawn(bridgePath, [], {
    env: { PATH: process.env.PATH, TMPDIR: workspace },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const decoder = new NativeInputFrameDecoder()
  assert.deepEqual(await nextMessage(child.stdout, decoder), {
    state: 'ready',
    type: 'bridge.ready',
  })
  const exited = once(child, 'exit')
  child.stdin.end()
  const [code, signal] = await exited
  assert.equal(code, 0)
  assert.equal(signal, null)
})

test('signed IME peer completes a correlated Desktop to Bridge operation', {
  skip: !isMacOS,
  timeout: 15_000,
}, async () => {
  const runtime = join(workspace, 'operation-runtime')
  const child = spawn(bridgePath, ['--operation-probe-listen', runtime], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const decoder = new NativeInputFrameDecoder()
  assert.deepEqual(await nextMessage(child.stdout, decoder), {
    state: 'ready',
    type: 'bridge.ready',
  })
  const ime = spawn(inputExecutable, [
    '--operation-probe', join(runtime, 'control.sock'),
  ], { stdio: ['ignore', 'pipe', 'pipe'] })

  child.stdin.write(encodeNativeInputFrame({
    type: 'session.arm',
    operationId: 'arm-1',
    statusVisible: true,
  }))
  assert.deepEqual(await nextMessage(child.stdout, decoder), {
    accepted: true,
    generation: 1,
    operationId: 'arm-1',
    sessionId: 'probe-session',
    targetId: 'probe-target',
    type: 'operation.result',
  })
  child.stdin.write(encodeNativeInputFrame({
    type: 'session.partial',
    operationId: 'partial-1',
    revision: 0,
    seq: 1,
    statusVisible: true,
    text: 'fake transcript',
  }))
  assert.deepEqual(await nextMessage(child.stdout, decoder), {
    accepted: true,
    operationId: 'partial-1',
    type: 'operation.result',
  })
  const [imeCode] = await once(ime, 'exit')
  assert.equal(imeCode, 0)

  const exited = once(child, 'exit')
  child.stdin.end(encodeNativeInputFrame({ type: 'bridge.stop' }))
  const [code] = await exited
  assert.equal(code, 0)
  assert.equal(readdirSync(workspace).includes('operation-runtime'), false)
})

test('real Bridge intercepts SIGTERM for owned recovery before exiting', {
  skip: !isMacOS,
  timeout: 15_000,
}, async () => {
  const runtime = join(workspace, 'signal-runtime')
  const child = spawn(bridgePath, ['--operation-probe-listen', runtime], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const decoder = new NativeInputFrameDecoder()
  assert.deepEqual(await nextMessage(child.stdout, decoder), {
    state: 'ready',
    type: 'bridge.ready',
  })
  const ime = spawn(inputExecutable, [
    '--operation-probe', join(runtime, 'control.sock'),
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  const imeExited = once(ime, 'exit')
  child.stdin.write(encodeNativeInputFrame({
    type: 'session.arm',
    operationId: 'signal-arm-1',
    statusVisible: true,
  }))
  assert.equal((await nextMessage(child.stdout, decoder)).accepted, true)
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  const [code, signal] = await exited
  assert.equal(code, 0)
  assert.equal(signal, null)
  assert.equal(readdirSync(workspace).includes('signal-runtime'), false)
  ime.kill('SIGTERM')
  await imeExited
})

async function sendAndExpect(host, request, state) {
  const response = once(host, 'message')
  host.send(request)
  const [message] = await response
  assert.deepEqual(message, {
    state,
    type: 'session.state',
  })
}

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
      reject(new Error('Bridge exited before sending a complete frame'))
    }
    const cleanup = () => {
      stream.off('data', onData)
      stream.off('end', onEnd)
    }
    stream.on('data', onData)
    stream.on('end', onEnd)
  })
}

function snapshotFiles(directory, prefix = '') {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = join(prefix, entry.name)
    if (entry.isDirectory()) {
      files.push(...snapshotFiles(join(directory, entry.name), relative))
    } else {
      files.push(relative)
    }
  }
  return files.sort()
}
