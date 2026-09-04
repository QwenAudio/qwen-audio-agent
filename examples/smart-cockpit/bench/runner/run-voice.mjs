#!/usr/bin/env node
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { DashScopeCockpitModel } from '../../agent/model.mjs'
import { startCockpitAgentServer } from '../../agent/server.mjs'
import { loadCockpitEnvironment } from '../../bootstrap/environment.mjs'
import { CockpitService } from '../../service/cockpit-service.mjs'
import { startCockpitServiceServer } from '../../service/server.mjs'
import { CockpitStateStore } from '../../service/state-store.mjs'
import { COCKPIT_SURFACE_ROUTING } from '../../service/tools/registry.mjs'
import {
  GatewayClient,
} from '../../../../shared/gateway-client-sdk.mjs'
import {
  GatewayClientCapability,
  GatewayClientProtocolEvent,
} from '../../../../shared/gateway-client-protocol.mjs'
import {
  GatewayClientEvent,
  GatewayServerEvent,
  GatewayTaskEvent,
} from '../../../../shared/realtime-events.mjs'
import { loadNavigationCases, routeCasesExpectedPaths } from '../evaluator/cases.mjs'
import { scoreTrace, summarizeScores } from '../evaluator/score.mjs'

const DEFAULT_COCKPIT_ID = 'voice-bench'
const DEFAULT_SAMPLE_RATE = 16_000
const DEFAULT_CHUNK_MS = 20
const DEFAULT_SILENCE_MS = 2_200
const DEFAULT_TURN_TIMEOUT_MS = 60_000
const DEFAULT_SETTLE_MS = 1_200
const DEFAULT_BETWEEN_CASE_MS = 1_000
const TRACE_IGNORED_TOOLS = new Set([
  'custom_skill_list',
])

const PLACES = new Map([
  ['西湖', '120.151,30.254'],
  ['灵隐寺', '120.102,30.241'],
  ['杭州东站', '120.212,30.291'],
  ['黄龙体育中心', '120.137,30.272'],
  ['城西银泰', '120.092,30.307'],
  ['萧山机场', '120.432,30.236'],
  ['机场', '120.432,30.236'],
  ['西溪湿地', '120.064,30.266'],
  ['滨江家', '120.205,30.188'],
  ['滨江公司', '120.215,30.211'],
  ['龙湖滨江天街', '120.210,30.208'],
  ['阿里西溪园区', '120.030,30.286'],
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function createBenchmarkService() {
  let timestamp = 1_700_000_000_000
  return new CockpitService({
    store: new CockpitStateStore({ now: () => timestamp++ }),
    now: () => timestamp++,
    services: {
      async vehicleLocation() {
        return {
          name: 'benchmark origin',
          city: '杭州市',
          district: '西湖区',
          address: '文三路',
          lng: 120.120,
          lat: 30.270,
        }
      },
      async resolvePlace(name) {
        return PLACES.get(name)
          || `120.${Math.max(100, String(name).length * 17)},30.${Math.max(100, String(name).length * 13)}`
      },
      async searchPlaces(query) {
        return [{ name: `${query}1号店`, location: '120.188,30.266' }]
      },
      async searchNearbyPlaces({ keywords }) {
        return [{ name: `${keywords}1号店`, location: '120.188,30.266', distance: 700 }]
      },
      async drivingRoute(origin, destination, strategy) {
        return {
          origin,
          destination,
          strategy,
          distance: 12_000,
          duration: 1_200,
          polyline: `${origin};${destination}`,
          trafficSegments: [],
        }
      },
    },
  })
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

async function runCase(caseItem, {
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
}) {
  serviceServer.service.reset(cockpitId)
  for (const call of caseItem.setup_calls || []) {
    await serviceServer.service.execute(call.name, call.arguments || {}, { cockpitId })
  }

  const calls = []
  const ignoredCalls = []
  let activeTurnIndex = null
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
  try {
    for (const [turnIndex, turn] of caseItem.turns.entries()) {
      const startIndex = events.length
      activeTurnIndex = turnIndex
      const speech = await synthesizeSpeechPcm(turn.user, {
        sampleRate: inputSampleRate,
        sayVoice,
      })
      await streamPcm(client, speech, { sampleRate: inputSampleRate, chunkMs })
      await streamPcm(client, silencePcm(silenceMs, inputSampleRate), {
        sampleRate: inputSampleRate,
        chunkMs,
      })
      await waitForTurn(events, startIndex, { timeoutMs: turnTimeoutMs, settleMs })
      activeTurnIndex = null
    }
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
      voice_events: events,
      final_state: await fetchState(serviceServer.origin, cockpitId),
    }
  } finally {
    activeTurnIndex = null
    unsubscribe()
    client.stop()
    await sleep(betweenCaseMs)
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
  process.env.QWAUDIO_DATA_DIR = runtimeRoot
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
    let cases = routeCasesExpectedPaths(loadNavigationCases(), COCKPIT_SURFACE_ROUTING)
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
      }))
    }

    const scores = cases.map((caseItem, index) => scoreTrace(caseItem, traces[index]))
    const report = {
      suite: 'smart-cockpit/navigation',
      mode: 'voice-realtime',
      realtime_model: process.env.QWEN_AUDIO_REALTIME_MODEL || null,
      agent_model: agentModel.model,
      routing: COCKPIT_SURFACE_ROUTING.domains,
      input_tts: {
        engine: 'macos_say',
        voice: args.get('say-voice') === true ? null : args.get('say-voice') || 'Ting-Ting',
      },
      created_at: new Date().toISOString(),
      summary: summarizeScores(scores),
      scores,
      traces,
    }

    const outPath = args.get('out')
      || 'examples/smart-cockpit/bench/reports/navigation-voice-realtime-latest.json'
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
