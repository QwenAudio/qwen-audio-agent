// Opt-in, short real-provider smoke test: node scripts/test/acp-parallel-live.mjs qwen --run
// Only existing qwen/opencode/qoder CLIs and credentials are used. Never installs
// software, changes user configuration, approves tools, or launches Claude/OpenClaw.
// Three text-only calls can incur provider charges. Work happens in a temporary
// directory; the test starts and closes only its own ACP process. Providers may
// retain their normal session history. This verifies concurrent ACP requests,
// not whether the provider internally runs model generation concurrently.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AcpBackendAdapter } from '../../server/src/backend/adapters/acp/backend-adapter.mjs'
import { AcpProcessClient } from '../../server/src/backend/adapters/acp/process-client.mjs'

const commands = {
  qwen: ['qwen', '--acp', '--safe-mode'],
  opencode: ['opencode', '--pure', 'acp'],
  qoder: ['qodercli', '--acp'],
}
const [name, confirmation, ...extra] = process.argv.slice(2)
if (name === '--help') {
  console.log('Usage: node scripts/test/acp-parallel-live.mjs <qwen|opencode|qoder> --run\nThree short text calls, 60s timeout, tools denied, temporary workspace; no user configuration changes.')
  process.exit(0)
}
if (!Object.hasOwn(commands, name || '') || confirmation !== '--run' || extra.length) {
  throw new Error('Explicit opt-in required: choose qwen, opencode, or qoder and append --run.')
}

const [command, ...args] = commands[name]
const directory = await mkdtemp(join(tmpdir(), 'qwa-parallel-'))
const controller = new AbortController()
const pairReady = Promise.withResolvers()
const launchPair = Promise.withResolvers()
const calls = []
const active = new Set()
const ended = new Set()
const results = []
let peak = 0
let deniedTools = 0
let timer
let closing
const started = Date.now()
const client = new AcpProcessClient({ label: name, command, args, cwd: directory,
  timeoutMs: 20_000,
  onPermission: async () => {
    deniedTools += 1
    controller.abort(new Error('A tool permission was requested; text-only smoke test stopped.'))
    return { outcome: { outcome: 'cancelled' } }
  },
  onElicitation: async () => ({ action: 'cancel' }),
})
const backend = new AcpBackendAdapter({ protocol: name, directory, client,
  builtinMcp: [], sessionStatePath: null, maxConcurrentTasks: 2,
  profile: { label: name, capabilities: {}, externalMcp: false, nativeDelegation: false,
    sessionMcp: false, acpConnection: { kind: 'process' } },
})
const closeBackend = () => (closing ||= backend.close())
const originalPrompt = client.prompt.bind(client)
client.prompt = async (sessionId, prompt, options = {}) => {
  const call = { sessionId, index: calls.length, reusedIdleSession: ended.has(sessionId) }
  calls.push(call)
  // Start the first two real RPCs together even when Session initialization has
  // unequal latency. The third submit must remain queued at the adapter pool.
  if (call.index < 2) {
    if (calls.length === 2) pairReady.resolve()
    await launchPair.promise
  }
  assert.ok(!active.has(sessionId), 'two prompts overlapped in the same Session')
  active.add(sessionId)
  peak = Math.max(peak, active.size)
  try {
    return await originalPrompt(sessionId, prompt, { ...options,
      onUpdate: update => {
        if (['tool_call', 'tool_call_update'].includes(update.sessionUpdate)) {
          deniedTools += 1
          controller.abort(new Error('Unexpected tool activity; text-only smoke test stopped.'))
          return
        }
        options.onUpdate?.(update)
      },
    })
  } finally {
    active.delete(sessionId)
    ended.add(sessionId)
  }
}

const submissions = []
try {
  timer = setTimeout(() => {
    controller.abort(new Error('ACP parallel live test exceeded its 60s global timeout.'))
    launchPair.resolve()
    // Kill only this test-owned connection; do not leave a blocked remote RPC
    // holding the process open beyond the global deadline.
    closeBackend().catch(() => {})
  }, 60_000)
  const nonce = randomBytes(4).toString('hex')
  const markers = ['A', 'B', 'C'].map(label => `PARALLEL_${label}_${nonce}`)
  for (const [index, marker] of markers.entries()) {
    const promise = backend.submit({ id: `parallel-${index}`, ownerId: `parallel-${nonce}`,
      objective: `纯文本协议测试：禁止使用工具、访问文件、执行命令、联网或委托。不要解释，只原样回复这个标记：${marker}`,
    }, { signal: controller.signal })
    promise.catch(error => { pairReady.reject(error); launchPair.resolve() })
    submissions.push(promise)
  }
  await pairReady.promise
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.length, 2, 'third task must wait while both slots are leased')
  assert.notEqual(calls[0].sessionId, calls[1].sessionId)
  launchPair.resolve()
  results.push(...await Promise.all(submissions))
  assert.equal(deniedTools, 0)
  assert.equal(peak, 2)
  assert.equal(calls.length, 3)
  assert.equal(new Set(calls.map(call => call.sessionId)).size, 2)
  assert.equal(calls[2].reusedIdleSession, true)
  let exactReplies = 0
  for (const [index, result] of results.entries()) {
    // Some providers expose a reasoning delimiter such as </think>. Keep that
    // formatting difference observable, but require each result to contain only
    // its own task marker, never a marker from another concurrent request.
    const returnedMarkers = [...new Set(result.content.match(new RegExp(`PARALLEL_[ABC]_${nonce}`, 'g')) || [])]
    assert.deepEqual(returnedMarkers, [markers[index]], `wrong result for task ${index}`)
    if (result.content.trim() === markers[index]) exactReplies += 1
  }
  console.log(JSON.stringify({ backend: name, passed: true, prompts: calls.length,
    peakInFlight: peak, sessions: 2, thirdWaited: true, thirdReusedIdleSession: true,
    markersMatched: results.length, exactReplies, toolCalls: deniedTools, elapsedMs: Date.now() - started }))
} catch (error) {
  console.error(JSON.stringify({ backend: name, passed: false, error: error.message,
    prompts: calls.length, peakInFlight: peak, toolCalls: deniedTools, elapsedMs: Date.now() - started }))
  process.exitCode = 1
} finally {
  clearTimeout(timer)
  controller.abort(new Error('Parallel smoke test finished'))
  launchPair.resolve()
  await closeBackend()
  await Promise.allSettled(submissions)
  await rm(directory, { recursive: true, force: true })
}
