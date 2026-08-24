import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import {
  cpSync,
  mkdtempSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import test from 'node:test'

import {
  NativeInputFrameDecoder,
  encodeNativeInputFrame,
} from '../src/native-input-protocol.mjs'

const root = resolve(new URL('../..', import.meta.url).pathname)
const diagnosticStderrMaxBytes = 512
const capturedStderrMaxBytes = 4_096

test('XPC diagnostics redact credentials and bound stderr', () => {
  const fixtureValue = 'diagnostic-fixture-value'
  const fixturePath = '/Users/fixture/private-build/output'
  const stderr = sanitizeDiagnosticStderr(
    `TOKEN=${fixtureValue} ${fixturePath} ${'界'.repeat(512)}`,
  )

  assert.equal(stderr.includes(fixtureValue), false)
  assert.equal(stderr.includes(fixturePath), false)
  assert.ok(Buffer.byteLength(stderr) <= 512)
})

test('real signed Bridge and IME accept only their exact peer identifiers', {
  skip: process.platform !== 'darwin',
  timeout: 30_000,
}, async t => {
  const workspace = mkdtempSync(join(tmpdir(), 'qwen-native-xpc-'))
  const output = join(workspace, 'build')
  const runtime = join(workspace, 'runtime')
  let bridge
  let bridgeStderr
  try {
    const buildStartedAt = performance.now()
    const build = spawnSync(process.execPath, [
      'scripts/build-native-input.mjs',
      '--configuration', 'Debug',
      '--arch', 'current',
      '--output', output,
    ], { cwd: root, encoding: 'utf8' })
    diagnoseProcess(t, 'build', buildStartedAt, build)
    assert.equal(
      build.status,
      0,
      sanitizeDiagnosticStderr(build.stderr || build.stdout) || 'Native input build failed',
    )

    const bridgePath = join(output, 'QwenInputBridge')
    const inputApp = join(output, 'Qwen Input.app')
    const inputExecutable = join(inputApp, 'Contents/MacOS/Qwen Input')
    const socketPath = join(runtime, 'control.sock')
    bridge = spawn(bridgePath, ['--peer-probe-listen', runtime], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const bridgeStartedAt = performance.now()
    bridgeStderr = captureStderr(bridge.stderr)
    bridge.once('exit', (code, signal) => {
      diagnose(t, {
        phase: 'bridge-exit',
        durationMs: elapsedMilliseconds(bridgeStartedAt),
        exitCode: code,
        signal,
        stderr: bridgeStderr.read(),
      })
    })
    const bridgeMessages = new NativeInputFrameDecoder()
    const ready = await nextMessage(bridge.stdout, bridgeMessages)
    assert.deepEqual(ready, { state: 'ready', type: 'bridge.ready' })

    const acceptedStartedAt = performance.now()
    const accepted = spawnSync(inputExecutable, ['--peer-probe', socketPath], {
      encoding: 'utf8',
      timeout: 3_000,
    })
    diagnoseProcess(t, 'accepted-probe', acceptedStartedAt, accepted)
    assert.equal(
      accepted.status,
      0,
      sanitizeDiagnosticStderr(accepted.stderr || accepted.error?.message)
        || 'Accepted IME probe failed',
    )

    const rejectedStartedAt = performance.now()
    const wrongApp = join(workspace, 'Wrong Input.app')
    cpSync(inputApp, wrongApp, { recursive: true })
    const resign = spawnSync('codesign', [
      '--force', '--deep', '--sign', '-',
      '--identifier', 'ai.qwenaudio.agent.wrong-input',
      wrongApp,
    ], { encoding: 'utf8' })
    assert.equal(
      resign.status,
      0,
      sanitizeDiagnosticStderr(resign.stderr) || 'Wrong-bundle fixture signing failed',
    )
    const rejected = spawnSync(
      join(wrongApp, 'Contents/MacOS/Qwen Input'),
      ['--peer-probe', socketPath],
      { encoding: 'utf8', timeout: 3_000 },
    )
    diagnoseProcess(t, 'rejected-probe', rejectedStartedAt, rejected)
    assert.notEqual(rejected.status, 0, 'wrong-bundle peer was accepted')

    const shutdownStartedAt = performance.now()
    bridge.stdin.end(encodeNativeInputFrame({ type: 'bridge.stop' }))
    const exit = await waitForExit(bridge)
    diagnose(t, {
      phase: 'shutdown',
      durationMs: elapsedMilliseconds(shutdownStartedAt),
      exitCode: exit.code,
      signal: exit.signal,
      stderr: bridgeStderr.read(),
    })
    assert.equal(exit.code, 0, bridgeStderr.read() || 'Bridge failed')
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

function captureStderr(stream) {
  const chunks = []
  let capturedBytes = 0
  stream.on('data', chunk => {
    if (capturedBytes >= capturedStderrMaxBytes) return
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    const captured = buffer.subarray(0, capturedStderrMaxBytes - capturedBytes)
    chunks.push(captured)
    capturedBytes += captured.length
  })
  return {
    read: () => sanitizeDiagnosticStderr(Buffer.concat(chunks)),
  }
}

function diagnoseProcess(t, phase, startedAt, result) {
  diagnose(t, {
    phase,
    durationMs: elapsedMilliseconds(startedAt),
    exitCode: result.status,
    signal: result.signal,
    spawnErrorCode: result.error?.code ?? null,
    stderr: sanitizeDiagnosticStderr(result.stderr),
  })
}

function diagnose(t, details) {
  t.diagnostic(`[native-input-xpc] ${JSON.stringify(details)}`)
}

function elapsedMilliseconds(startedAt) {
  return Math.round((performance.now() - startedAt) * 100) / 100
}

function sanitizeDiagnosticStderr(stderr) {
  const value = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? '')
  const sanitized = value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\b(?:api[_-]?key|token|secret|password)\b\s*[:=]\s*\S+/gi, '[credential]=[redacted]')
    .replace(/\bbearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9._-]{8,}\b/g, '[redacted]')
    .replace(/(?:\/[A-Za-z0-9._ -]+){2,}/g, '[path]')
    .replace(/\s+/g, ' ')
    .trim()
  return truncateUtf8(sanitized, diagnosticStderrMaxBytes)
}

function truncateUtf8(value, maxBytes) {
  if (Buffer.byteLength(value) <= maxBytes) return value
  const marker = '…[truncated]'
  const budget = maxBytes - Buffer.byteLength(marker)
  let bytes = 0
  let output = ''
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character)
    if (bytes + characterBytes > budget) break
    output += character
    bytes += characterBytes
  }
  return output + marker
}
