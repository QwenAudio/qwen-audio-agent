import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { loadServiceEnvironment } from '../bootstrap/environment.mjs'
import { startCustomerServiceServer } from '../service/server.mjs'
import { startServiceAgentServer } from '../agent/server.mjs'
import { DashScopeServiceModel } from '../agent/model.mjs'
import { createRealtimeOnly, createFullHarness, withTauPolicy } from './realtime-harness.mjs'
import { createMaxOnly } from './max-only.mjs'

loadServiceEnvironment()
const runtimeRoot = mkdtempSync(join(tmpdir(), 'qwen-tau-harness-'))
// Must precede gateway imports: never read/write the user's global runtime state.
process.env.QWAUDIO_CONFIG_DIR = runtimeRoot
process.env.QWAUDIO_DATA_DIR = runtimeRoot
process.env.NODE_ENV = 'test'
const root = process.env.CS_TAU2_ROOT
const python = process.env.CS_TAU2_PYTHON
if (!root || !python) throw new Error('Set CS_TAU2_ROOT and CS_TAU2_PYTHON')
const mode = process.env.CS_TAU_MODE || 'harness'
if (!['realtime-only', 'harness', 'max-only'].includes(mode)) throw new Error('Invalid CS_TAU_MODE')
const outputDir = resolve(process.env.CS_TAU_OUTPUT_DIR || 'examples/customer-service/.runtime/tau-harness')
mkdirSync(outputDir, { recursive: true })
const [{ config }, { resolveRealtimeProvider }] = await Promise.all([
  import('../../../server/src/core/config.mjs'), import('../../../server/src/voice/providers/registry.mjs'),
])
const originalProvider = resolveRealtimeProvider('dashscope')
const userModel = process.env.CS_TAU_USER_MODEL || 'qwen3.8-flash'
const judgeModel = process.env.CS_TAU_JUDGE_MODEL || 'qwen3.8-flash'
const backendModel = process.env.CS_TAU_BACKEND_MODEL || 'qwen3.8-max'
const baseURL = process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
const cases = process.argv.slice(2)
if (!cases.length) cases.push('retail:0', 'airline:8')
console.log(JSON.stringify({ mode, realtimeModel: mode === 'max-only' ? null : originalProvider.model(), backendModel: mode !== 'realtime-only' ? backendModel : null,
  userModel, judgeModel, input: 'text', output: 'text', cases, runtimeRoot }))

async function runCase(domain, taskId) {
  const start = Date.now(), events = [], dialogue = []
  const signal = AbortSignal.timeout(300_000)
  const server = await startCustomerServiceServer({ port: 0, testMode: true, testToken: randomUUID(), tauRoot: root, tauPython: python })
  const scenarios = server.service.scenarios
  scenarios.timeoutMs = 110_000
  let loaded, client, agent, failure, scoringFailure, scored, stage = 'load', terminationReason = 'max_steps'
  let userTurns = 0, backendModelCalls = 0
  try {
    loaded = await scenarios.load({ domain, taskId })
    const context = scenarios.context(loaded.sessionId)
    const provider = withTauPolicy(originalProvider, { mode, policy: context.policy, definitions: context.definitions })
    stage = 'user-simulator'
    await scenarios.request('user-init', loaded.sessionId, { model: userModel, baseURL })
    stage = 'realtime-connect'
    if (mode === 'harness') {
      const model = new DashScopeServiceModel({ model: backendModel })
      agent = await startServiceAgentServer({ port: 0, serviceOrigin: server.origin, sessionId: loaded.sessionId,
        model: { complete: options => { backendModelCalls += 1; return model.complete(options) } } })
      const directory = resolve(runtimeRoot, `${domain}-${taskId}-${randomUUID()}`)
      mkdirSync(directory, { recursive: true })
      client = await createFullHarness({ provider, agentServer: agent, serviceOrigin: server.origin,
        sessionId: loaded.sessionId, definitions: context.definitions, directory, config, signal, events })
    } else if (mode === 'max-only') {
      client = await createMaxOnly({ scenarios, sessionId: loaded.sessionId,
        model: backendModel, baseURL, signal })
    } else {
      client = await createRealtimeOnly({ provider, scenarios, sessionId: loaded.sessionId, signal, events })
    }
    let assistant = ''
    while (userTurns < 16) {
      signal.throwIfAborted()
      stage = 'user-simulator'
      const reply = await scenarios.request('user-turn', loaded.sessionId, { content: assistant })
      if (assistant) dialogue.push({ role: 'assistant', content: assistant })
      dialogue.push({ role: 'user', content: reply.content })
      userTurns += 1
      console.log(`${mode} ${domain}:${taskId} user turn ${userTurns}`)
      if (reply.stop) { terminationReason = 'user_stop'; break }
      stage = 'harness'
      assistant = await client.turn(reply.content)
    }
  } catch (error) {
    failure = error.message
    terminationReason = signal.aborted ? 'timeout' : stage === 'user-simulator' ? 'user_error' : 'agent_error'
  }
  const counts = client?.counts() || {}
  // Stop outstanding work before grading. STOP never authorizes a later write.
  try { await client?.close(); await agent?.close() } catch (error) { failure ||= `Cleanup failed: ${error.message}` }
  try {
    if (loaded) scored = await scenarios.request('score', loaded.sessionId, {
      startTime: new Date(start).toISOString(), endTime: new Date().toISOString(),
      duration: (Date.now() - start) / 1000, terminationReason, judgeModel, baseURL,
    })
  } catch (error) { scoringFailure = error.message }
  const result = { mode, scope: mode === 'harness'
    ? 'text-input/output: Realtime WebSocket -> real Gateway/TaskManager/MCP/A2A/approval -> backend -> Realtime response'
    : mode === 'max-only' ? 'text-input/output: native tau2 LLMAgent -> official tau tools; no Realtime/Gateway/A2A/approval runtime'
    : 'text-input/output: Realtime WebSocket -> official tau tools; no Gateway/backend/extra approval runtime',
  domain, taskId, realtimeModel: mode === 'max-only' ? null : originalProvider.model(), backendModel: mode !== 'realtime-only' ? backendModel : null,
  userModel, judgeModel, sourceCommit: loaded?.sourceCommit, sourceDirty: loaded?.sourceDirty,
  limits: { maxUserTurns: 16, timeoutSeconds: 300,
    backendModelRoundsPerExecution: mode === 'harness' ? 8 : null,
    maxModelRoundsPerUserTurn: mode === 'max-only' ? 100 : null },
  terminationReason, failure, failureStage: failure ? stage : undefined, scoringFailure,
  userTurns, backendModelCalls, ...counts,
  executedToolCalls: scored?.messages?.reduce((sum, message) => sum + (message.tool_calls?.length || 0), 0),
  durationSeconds: (Date.now() - start) / 1000, dialogue, events, ...scored }
  const path = resolve(outputDir, `${mode}-${domain}-${taskId}-${Date.now()}.json`)
  writeFileSync(path, JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ mode, domain, taskId, reward: result.reward?.reward, failure, scoringFailure,
    replayMatchesLive: result.replayMatchesLive, userTurns, backendModelCalls, ...counts, path }))
  await server.close()
}

for (const entry of cases) {
  const [domain, id] = entry.split(':')
  await runCase(domain, id)
}
