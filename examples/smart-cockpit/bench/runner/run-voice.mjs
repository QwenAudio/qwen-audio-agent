#!/usr/bin/env node
import { once } from 'node:events'
import { appendFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { DashScopeCockpitModel } from '../../agent/model.mjs'
import { startCockpitAgentServer } from '../../agent/server.mjs'
import { loadCockpitEnvironment } from '../../bootstrap/environment.mjs'
import { startCockpitServiceServer } from '../../service/server.mjs'
import { COCKPIT_SURFACE_ROUTING } from '../../service/tools/registry.mjs'
import {
  GatewayClient,
} from 'qwen-audio-agent/gateway-client-sdk'
import {
  GatewayClientCapability,
  GatewayClientProtocolEvent,
} from 'qwen-audio-agent/gateway-client-protocol'
import {
  GatewayClientEvent,
  GatewayServerEvent,
  GatewayTaskEvent,
} from 'qwen-audio-agent/realtime-events'
import { loadBenchmarkCases, routeCasesExpectedPaths } from '../evaluator/cases.mjs'
import { scoreTrace, summarizeScores } from '../evaluator/score.mjs'
// One deterministic service for every measured subject: the text, realtime and
// harness runs must see identical places, routes and weather, or the gold state
// assertions stop being comparable.
import { createBenchmarkService } from './controlled-harness.mjs'

const BENCHMARK_DOMAINS = Object.freeze(['vehicle', 'music', 'navigation', 'weather'])

const DEFAULT_COCKPIT_ID = 'voice-bench'
const DEFAULT_SAMPLE_RATE = 16_000
const DEFAULT_CHUNK_MS = 20
const DEFAULT_SILENCE_MS = 2_200
const DEFAULT_TURN_TIMEOUT_MS = 60_000
const DEFAULT_SETTLE_MS = 1_200
const DEFAULT_BETWEEN_CASE_MS = 1_000
const DEFAULT_RETRY_BACKOFF_MS = 2_000
// Matched to the realtime runner so both subjects recover from the same faults.
const DEFAULT_TURN_RETRIES = 1
const DEFAULT_CASE_ATTEMPTS = 2

const TURN_TIMEOUT_PATTERN = /Timed out waiting for realtime turn/u

function isTurnTimeout(error) {
  return TURN_TIMEOUT_PATTERN.test(String(error?.message || error || ''))
}

const TRACE_IGNORED_TOOLS = new Set([
  'custom_skill_list',
])

function parseArgs(argv) {
  const args = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index]
    if (!raw.startsWith('--')) continue
    const key = raw.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) {
      args.set(key, true)
      continue
    }
    args.set(key, next)
    index += 1
  }
  return args
}

function numberArg(args, key, fallback) {
  const value = Number(args.get(key))
  return Number.isFinite(value) && value > 0 ? value : fallback
}

// numberArg only accepts positive numbers; a retry count has to allow 0 so
// retries can be switched off completely.
function countArg(args, key, fallback) {
  if (!args.has(key)) return fallback
  const value = Number(args.get(key))
  return Number.isInteger(value) && value >= 0 ? value : fallback
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function runProcess(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: options.encoding,
    input: options.input,
    maxBuffer: 20 * 1024 * 1024,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString('utf8')
      : String(result.stderr || '')
    throw new Error(`${command} failed: ${stderr.trim()}`)
  }
  return result.stdout
}

async function synthesizeSpeechPcm(text, {
  sampleRate = DEFAULT_SAMPLE_RATE,
  sayVoice = 'Ting-Ting',
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'qwen-cockpit-voice-turn-'))
  const aiffPath = join(root, 'speech.aiff')
  try {
    const sayArgs = sayVoice
      ? ['-v', sayVoice, '-o', aiffPath, text]
      : ['-o', aiffPath, text]
    try {
      runProcess('say', sayArgs, { encoding: 'utf8' })
    } catch (error) {
      if (!sayVoice) throw error
      runProcess('say', ['-o', aiffPath, text], { encoding: 'utf8' })
    }
    return runProcess('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      aiffPath,
      '-ac',
      '1',
      '-ar',
      String(sampleRate),
      '-f',
      's16le',
      'pipe:1',
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function silencePcm(ms, sampleRate = DEFAULT_SAMPLE_RATE) {
  const samples = Math.ceil((sampleRate * ms) / 1000)
  return Buffer.alloc(samples * 2)
}

async function streamPcm(client, pcm, {
  sampleRate = DEFAULT_SAMPLE_RATE,
  chunkMs = DEFAULT_CHUNK_MS,
} = {}) {
  const bytesPerSample = 2
  const samplesPerChunk = Math.max(1, Math.round((sampleRate * chunkMs) / 1000))
  const chunkBytes = samplesPerChunk * bytesPerSample
  for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
    const chunk = pcm.subarray(offset, Math.min(offset + chunkBytes, pcm.length))
    const sent = client.send({
      type: GatewayClientProtocolEvent.INPUT_AUDIO_APPEND,
      audio: chunk.toString('base64'),
    })
    if (!sent) throw new Error('Gateway connection closed while streaming audio')
    await sleep(chunkMs)
  }
}

function eventSummary(event) {
  if (event.type === GatewayServerEvent.TRANSCRIPT_FINAL) {
    return `${event.role}: ${event.content}`
  }
  if (event.type === GatewayServerEvent.ERROR) return event.message || event.error?.message || 'error'
  return event.type
}

async function waitForTurn(events, startIndex, {
  timeoutMs = DEFAULT_TURN_TIMEOUT_MS,
  settleMs = DEFAULT_SETTLE_MS,
} = {}) {
  const deadline = Date.now() + timeoutMs
  let cursor = startIndex
  let lastEventAt = Date.now()
  let sawUserFinal = false
  let sawAssistantFinal = false
  let sawTaskTerminal = false
  while (Date.now() < deadline) {
    while (cursor < events.length) {
      const event = events[cursor]
      cursor += 1
      lastEventAt = Date.now()
      if (event.type === GatewayServerEvent.ERROR) {
        throw new Error(event.message || event.error?.message || 'Gateway realtime error')
      }
      if (event.type === GatewayServerEvent.TRANSCRIPT_FINAL && event.role === 'user') {
        sawUserFinal = true
      }
      if (
        event.type === GatewayServerEvent.TRANSCRIPT_FINAL
        && event.role === 'assistant'
        && String(event.content || '').trim()
      ) {
        sawAssistantFinal = true
      }
      if ([
        GatewayTaskEvent.COMPLETED,
        GatewayTaskEvent.FAILED,
        GatewayTaskEvent.CANCELLED,
      ].includes(event.type)) {
        sawTaskTerminal = true
      }
    }
    const completeEnough = sawAssistantFinal || (sawUserFinal && sawTaskTerminal)
    if (completeEnough && Date.now() - lastEventAt >= settleMs) return
    await sleep(100)
  }
  const recent = events.slice(Math.max(startIndex, events.length - 12)).map(eventSummary)
  throw new Error(`Timed out waiting for realtime turn. Recent events: ${recent.join(' | ')}`)
}

async function waitForVoiceClientReady({ gatewayOrigin, sessionId, outputVoice }) {
  const events = []
  const playbackStarted = new Set()
  let resolveReady
  let rejectReady
  let resolveVoice
  let rejectVoice
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const voiceReady = new Promise((resolve, reject) => {
    resolveVoice = resolve
    rejectVoice = reject
  })
  const wsUrl = new URL('/api/realtime', gatewayOrigin)
  wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:'
  wsUrl.searchParams.set('sessionId', sessionId)

  const client = new GatewayClient({
    url: wsUrl.toString(),
    createSocket: url => new WebSocket(url),
    clientType: 'benchmark',
    clientVersion: '1.0.0',
    clientInstanceId: `voice-bench-${randomUUID()}`,
    clientLabel: 'Smart Cockpit Voice Benchmark',
    reconnect: false,
    capabilities: [
      GatewayClientCapability.INPUT_AUDIO,
      GatewayClientCapability.INPUT_TEXT,
      GatewayClientCapability.PLAYBACK_RECEIPTS,
      GatewayClientCapability.TASK_COMMANDS,
      GatewayClientCapability.PERMISSION_RESPOND,
      GatewayClientCapability.CONVERSATION_HISTORY,
      GatewayClientCapability.CLIENT_EVENTS,
      GatewayClientCapability.SESSION_OUTPUT_VOICE,
      GatewayClientCapability.SESSION_REPLAY,
    ],
    locale: 'zh-CN',
    timeZone: 'Asia/Shanghai',
    configure: {
      voiceEnabled: true,
      inputEnabled: true,
      outputEnabled: true,
      textOnly: false,
      outputVoice,
    },
    onStatus(status) {
      if (status.state === 'ready') resolveReady()
      if (status.state === 'unavailable') {
        rejectReady(status.error || new Error('Gateway connection unavailable'))
        rejectVoice(status.error || new Error('Gateway connection unavailable'))
      }
    },
    onEvent(event) {
      events.push(event)
      if (event.type === GatewayServerEvent.VOICE_READY) resolveVoice(event)
      if (event.type === GatewayServerEvent.ERROR) rejectVoice(
        new Error(event.message || event.error?.message || 'Gateway realtime error'),
      )
      if (event.type === GatewayServerEvent.AUDIO_DELTA && event.responseId) {
        if (!playbackStarted.has(event.responseId)) {
          playbackStarted.add(event.responseId)
          client.send({ type: GatewayClientEvent.PLAYBACK_STARTED, responseId: event.responseId })
        }
      }
      if (event.type === GatewayServerEvent.AUDIO_DONE && event.responseId) {
        if (!playbackStarted.has(event.responseId)) {
          playbackStarted.add(event.responseId)
          client.send({ type: GatewayClientEvent.PLAYBACK_STARTED, responseId: event.responseId })
        }
        client.send({ type: GatewayClientEvent.PLAYBACK_ENDED, responseId: event.responseId })
      }
    },
  })
  client.start()
  let timeout
  const readyTimeout = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error('Timed out waiting for Gateway voice client readiness'))
    }, 30_000)
  })
  try {
    await Promise.race([ready, readyTimeout])
    client.send({ type: GatewayClientEvent.UNMUTE })
    client.send({ type: GatewayClientEvent.INPUT_UNMUTE })
    const readyEvent = await Promise.race([voiceReady, readyTimeout])
    return { client, events, inputSampleRate: readyEvent.inputSampleRate || DEFAULT_SAMPLE_RATE }
  } catch (error) {
    client.stop()
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchState(origin, cockpitId) {
  const url = new URL('/api/cockpit/state', origin)
  url.searchParams.set('cockpitId', cockpitId)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`State fetch failed: ${response.status}`)
  return response.json()
}

async function attemptCase(caseItem, {
  serviceServer,
  gatewayOrigin,
  cockpitId,
  outputVoice,
  sayVoice,
  silenceMs,
  chunkMs,
  turnTimeoutMs,
  settleMs,
  betweenCaseMs,
  turnRetries,
}) {
  serviceServer.service.reset(cockpitId)
  for (const call of caseItem.setup_calls || []) {
    await serviceServer.service.execute(call.name, call.arguments || {}, { cockpitId })
  }

  const calls = []
  const ignoredCalls = []
  const stateSnapshots = []
  const turnRetryLog = []
  let activeTurnIndex = null
  let completedTurns = 0
  let failedTurnIndex = null
  const unsubscribe = serviceServer.subscribeToolCalls(event => {
    if (event.cockpitId !== cockpitId || activeTurnIndex === null) return
    const call = {
      turn_index: activeTurnIndex,
      path: event.surface,
      name: event.name,
      arguments: event.arguments || {},
    }
    if (TRACE_IGNORED_TOOLS.has(event.name)) ignoredCalls.push(call)
    else calls.push(call)
  })
  const sessionId = `${caseItem.id}-${randomUUID()}`
  const { client, events, inputSampleRate } = await waitForVoiceClientReady({
    gatewayOrigin,
    sessionId,
    outputVoice,
  })
  const collect = error => {
    const assistantMessages = events
      .filter(event => (
        event.type === GatewayServerEvent.TRANSCRIPT_FINAL
        && event.role === 'assistant'
        && String(event.content || '').trim()
      ))
      .map(event => event.content.trim())
    return {
      id: caseItem.id,
      calls,
      ignored_calls: ignoredCalls,
      assistant_messages: assistantMessages,
      state_snapshots: stateSnapshots,
      voice_events: events,
      completed_turns: completedTurns,
      failed_turn_index: failedTurnIndex,
      turn_retries: turnRetryLog,
      ...(error ? { error: { message: error.message || String(error) } } : {}),
    }
  }
  try {
    for (const [turnIndex, turn] of caseItem.turns.entries()) {
      activeTurnIndex = turnIndex
      const speech = await synthesizeSpeechPcm(turn.user, {
        sampleRate: inputSampleRate,
        sayVoice,
      })
      for (let attempt = 0; ; attempt += 1) {
        const startIndex = events.length
        const callsBefore = calls.length
        const messagesBefore = events.filter(event => (
          event.type === GatewayServerEvent.TRANSCRIPT_FINAL && event.role === 'assistant'
        )).length
        await streamPcm(client, speech, { sampleRate: inputSampleRate, chunkMs })
        await streamPcm(client, silencePcm(silenceMs, inputSampleRate), {
          sampleRate: inputSampleRate,
          chunkMs,
        })
        try {
          await waitForTurn(events, startIndex, { timeoutMs: turnTimeoutMs, settleMs })
          break
        } catch (error) {
          // Only a silent timeout is retried: this turn produced neither a tool
          // call nor a reply, so resending the audio cannot duplicate work.
          // A timeout after output is a generation stall; resending would
          // pollute the trace, so it goes up to the case-level retry.
          const silent = calls.length === callsBefore
            && events.filter(event => (
              event.type === GatewayServerEvent.TRANSCRIPT_FINAL && event.role === 'assistant'
            )).length === messagesBefore
          if (!isTurnTimeout(error) || !silent || attempt >= turnRetries) {
            failedTurnIndex = turnIndex
            return collect(error)
          }
          turnRetryLog.push({
            turn_index: turnIndex,
            attempt: attempt + 1,
            reason: 'silent_turn_timeout',
          })
          process.stderr.write(`  turn ${turnIndex} silent timeout, retrying audio\n`)
          await sleep(DEFAULT_RETRY_BACKOFF_MS)
        }
      }
      // The scorer needs one snapshot per turn, otherwise every long-suite
      // state checkpoint is counted as a failure.
      stateSnapshots.push({
        turn_index: turnIndex,
        state: serviceServer.service.snapshot(cockpitId),
      })
      completedTurns = turnIndex + 1
      activeTurnIndex = null
    }
    return {
      ...collect(null),
      final_state: await fetchState(serviceServer.origin, cockpitId),
    }
  } catch (error) {
    return {
      ...collect(error),
      final_state: serviceServer.service.snapshot(cockpitId),
    }
  } finally {
    activeTurnIndex = null
    unsubscribe()
    client.stop()
    await sleep(betweenCaseMs)
  }
}

// A timeout can come from streaming, the provider connection or a generation
// stall. A case runs at most caseAttempts times; failing at the same turn every
// time is a stable defect of that case, otherwise it is infrastructure jitter.
async function runCase(caseItem, options) {
  const maxAttempts = Math.max(1, options.caseAttempts)
  const attempts = []
  let selected = null

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1) {
      process.stderr.write(`  retrying whole case (attempt ${attempt}/${maxAttempts})\n`)
      await sleep(DEFAULT_RETRY_BACKOFF_MS)
    }
    const trace = await attemptCase(caseItem, options)
    attempts.push({
      attempt,
      completed_turns: trace.completed_turns,
      failed_turn_index: trace.failed_turn_index ?? null,
      turn_retries: trace.turn_retries.length,
      error: trace.error?.message ?? null,
    })
    // The attempt that got furthest is scored, and the report says which one,
    // so no good result is picked silently.
    if (!selected || trace.completed_turns > selected.completed_turns) selected = trace
    if (!trace.error) break
  }

  const failedTurns = attempts
    .filter(item => item.failed_turn_index !== null)
    .map(item => item.failed_turn_index)
  const allFailed = attempts.every(item => item.error)
  const sameTurn = failedTurns.length >= 2
    && failedTurns.every(index => index === failedTurns[0])

  return {
    ...selected,
    attempts,
    selected_attempt: attempts.find(item => (
      item.completed_turns === selected.completed_turns
    ))?.attempt ?? 1,
    retry_diagnosis: !allFailed
      ? 'recovered'
      : sameTurn
        ? 'confirmed_failure_at_turn'
        : 'unstable_infrastructure',
    confirmed_failure_turn: allFailed && sameTurn ? failedTurns[0] : null,
  }
}

async function waitForServerListening(server) {
  if (server.listening) return
  await once(server, 'listening')
}

async function main() {
  loadCockpitEnvironment()
  const args = parseArgs(process.argv.slice(2))
  if (args.get('realtime-model')) {
    process.env.QWEN_AUDIO_REALTIME_MODEL = String(args.get('realtime-model'))
  }

  const cockpitId = String(args.get('cockpit-id') || DEFAULT_COCKPIT_ID)
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'qwen-cockpit-voice-bench-'))
  process.env.QWAUDIO_CONFIG_DIR = runtimeRoot
  process.env.QWAUDIO_DATA_DIR = resolve(runtimeRoot, 'data')
  if (args.get('frontend-profile')) {
    process.env.QWEN_AUDIO_FRONTEND_PROFILE = String(args.get('frontend-profile'))
  } else {
    delete process.env.QWEN_AUDIO_FRONTEND_PROFILE
  }

  let serviceServer
  let agentServer
  let gatewayRuntime
  try {
    serviceServer = await startCockpitServiceServer({
      service: createBenchmarkService(),
      port: 0,
    })
    process.env.COCKPIT_SERVICE_ORIGIN = serviceServer.origin
    process.env.COCKPIT_ID = cockpitId
    delete process.env.COCKPIT_FRONTEND_MCP_URL

    const agentModel = new DashScopeCockpitModel({
      model: args.get('agent-model') || process.env.DASHSCOPE_MODEL,
    })
    agentServer = await startCockpitAgentServer({
      port: 0,
      serviceOrigin: serviceServer.origin,
      cockpitId,
      model: agentModel,
    })
    const { startCockpitGateway } = await import('../../gateway/server.mjs')
    // Benchmark-only persona discipline: importing the Gateway just copied
    // healer.md into the temp config dir, so appending here never touches the
    // production persona. Without it the gentle production persona hesitates
    // on clear intents (asking which airport instead of calling
    // navigation_start), while the text and realtime runners' benchmark
    // prompt already carries this rule.
    appendFileSync(
      join(runtimeRoot, 'assistant', 'healer.md'),
      '\n# 评测纪律\n\n普通闲聊、背景讨论、情绪表达、玩笑或没有可执行意图的感叹不要触发工具；等用户给出明确车控、音乐、导航或天气意图时立即调用对应工具，不要反问已经给出的信息。跨领域干扰时只执行用户当前明确要求的领域。\n',
    )
    gatewayRuntime = startCockpitGateway({
      port: 0,
      agentCardUrl: agentServer.agentCardUrl,
    })
    await waitForServerListening(gatewayRuntime.server)
    await gatewayRuntime.agent.start()
    const gatewayAddress = gatewayRuntime.server.address()
    const gatewayOrigin = `http://127.0.0.1:${gatewayAddress.port}`

    const limit = Number(args.get('limit') || 0)
    const caseId = args.get('case-id')
    // Same suite selection as the text and realtime runners, so the three
    // measured subjects cover the same cases.
    const suite = String(args.get('suite') || 'short')
    const requestedDomains = args.get('domain')
      ? String(args.get('domain')).split(',').map(item => item.trim()).filter(Boolean)
      : BENCHMARK_DOMAINS
    const domains = suite === 'short' ? requestedDomains : BENCHMARK_DOMAINS
    let cases = routeCasesExpectedPaths(
      loadBenchmarkCases({ domains: requestedDomains, suite }),
      COCKPIT_SURFACE_ROUTING,
    )
    if (caseId) cases = cases.filter(item => item.id === caseId)
    if (limit > 0) cases = cases.slice(0, limit)
    if (!cases.length) throw new Error('No benchmark cases selected')

    const traces = []
    for (const [index, caseItem] of cases.entries()) {
      process.stderr.write(`[${index + 1}/${cases.length}] ${caseItem.id}\n`)
      traces.push(await runCase(caseItem, {
        serviceServer,
        gatewayOrigin,
        cockpitId,
        outputVoice: args.get('voice') || process.env.QWEN_AUDIO_OUTPUT_VOICE,
        sayVoice: args.get('say-voice') === true ? undefined : args.get('say-voice') || 'Ting-Ting',
        silenceMs: numberArg(args, 'silence-ms', DEFAULT_SILENCE_MS),
        chunkMs: numberArg(args, 'chunk-ms', DEFAULT_CHUNK_MS),
        turnTimeoutMs: numberArg(args, 'timeout-ms', DEFAULT_TURN_TIMEOUT_MS),
        settleMs: numberArg(args, 'settle-ms', DEFAULT_SETTLE_MS),
        betweenCaseMs: numberArg(args, 'between-case-ms', DEFAULT_BETWEEN_CASE_MS),
        turnRetries: countArg(args, 'turn-retries', DEFAULT_TURN_RETRIES),
        caseAttempts: countArg(args, 'case-attempts', DEFAULT_CASE_ATTEMPTS),
      }))
    }

    const scores = cases.map((caseItem, index) => scoreTrace(caseItem, traces[index]))
    const report = {
      suite: 'smart-cockpit/cockpit',
      mode: 'voice-realtime',
      benchmark_suite: suite,
      domains,
      realtime_model: process.env.QWEN_AUDIO_REALTIME_MODEL || null,
      agent_model: agentModel.model,
      routing: COCKPIT_SURFACE_ROUTING.domains,
      input_tts: {
        engine: 'macos_say',
        voice: args.get('say-voice') === true ? null : args.get('say-voice') || 'Ting-Ting',
      },
      turn_retries: countArg(args, 'turn-retries', DEFAULT_TURN_RETRIES),
      case_attempts: countArg(args, 'case-attempts', DEFAULT_CASE_ATTEMPTS),
      created_at: new Date().toISOString(),
      summary: summarizeScores(scores),
      scores,
      traces,
    }

    const outPath = args.get('out')
      || 'examples/smart-cockpit/bench/reports/cockpit-voice-realtime-latest.json'
    const absolute = resolve(String(outPath))
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, `${JSON.stringify(report, null, 2)}\n`)
    console.log(JSON.stringify(report.summary, null, 2))
    console.log(`report: ${absolute}`)
  } finally {
    await gatewayRuntime?.close()
    await agentServer?.close()
    await serviceServer?.close()
    await rm(runtimeRoot, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
