#!/usr/bin/env node
// Single-surface latency worker (frontend realtime-api / backend A2A Agent) under
// audio input.
//
// Unlike surface-latency-worker.mjs this drives *real audio and real models*: the
// case utterance is synthesized to 16 kHz PCM with macOS `say` plus ffmpeg (the
// same audio simulator as run-voice.mjs), streamed to the Gateway's /api/realtime
// in 20 ms chunks, and the live realtime model decides which tools to call.
//
// Zero point: *the instant the utterance ends*, when the speech stream is done and
// before the trailing silence. It has to be measured there: anchoring on
// session.created or the first frame would hide the VAD silence wait and make that
// wait look like model or TTS time.
//
// Key metrics, all relative to the zero point:
//   tool_before_ms — the latest service.execute start in the turn
//   tool_after_ms  — the latest resolve/reject once every invoked tool has finished
//   first_audio_ms — the client received the first audio frame, which is not
//                    actual speaker playback
//
// Surface routing is frozen when registry.mjs loads, so each routing needs its own
// process. This file runs one of them; run-voice-surface-compare.mjs spawns both.
import { once } from 'node:events'
import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { loadBenchmarkCases, routeCasesExpectedPaths } from '../evaluator/cases.mjs'
import { scoreTrace, summarizeScores } from '../evaluator/score.mjs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import WebSocket from 'ws'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { DashScopeCockpitModel } from '../../agent/model.mjs'
import { startCockpitAgentServer } from '../../agent/server.mjs'
import { loadCockpitEnvironment } from '../../bootstrap/environment.mjs'
import { startCockpitServiceServer } from '../../service/server.mjs'
import { CockpitService } from '../../service/cockpit-service.mjs'
import { createAmapCockpitServices } from '../../service/integrations/amap/services.mjs'
import { COCKPIT_SURFACE_ROUTING } from '../../service/tools/registry.mjs'
import { GatewayClient } from 'qwen-audio-agent/gateway-client-sdk'
import {
  GatewayClientCapability,
  GatewayClientProtocolEvent,
} from 'qwen-audio-agent/gateway-client-protocol'
import {
  GatewayClientEvent,
  GatewayServerEvent,
  GatewayTaskEvent,
} from 'qwen-audio-agent/realtime-events'
import { createBenchmarkService, parseRunnerArgs, numberArg, sleep } from './controlled-harness.mjs'

const CASES_URL = new URL('../cases/surface-compare.jsonl', import.meta.url)
const SAMPLE_RATE = 16_000
const CHUNK_MS = 20
// The Agent probes its skill catalog on every task; that is not a cockpit action under test.
const IGNORED_TOOLS = new Set(['custom_skill_list'])
const TASK_TERMINAL = new Set([
  GatewayTaskEvent.COMPLETED,
  GatewayTaskEvent.FAILED,
  GatewayTaskEvent.CANCELLED,
])

function safeMessage(error) {
  let text = String(error?.message || error || '')
  for (const key of ['DASHSCOPE_API_KEY', 'AMAP_MCP_KEY']) {
    if (process.env[key]) text = text.replaceAll(process.env[key], '[REDACTED]')
  }
  return text.replace(/([?&](?:key|api_key)=)[^&\s]+/giu, '$1[REDACTED]')
}

export function liveDomainsFor(cases) {
  const domains = new Set(cases.map(item => item.domain))
  for (const item of cases) {
    for (const call of [...(item.setup_calls || []), ...(item.expected_calls || [])]) {
      if (call.name === 'weather') domains.add('weather')
      if (call.name.startsWith('navigation_')) domains.add('navigation')
    }
  }
  return ['weather', 'navigation'].filter(domain => domains.has(domain))
}

export function assertVoiceCredentials(cases, mode, env = process.env) {
  if (!env.DASHSCOPE_API_KEY?.trim()) throw new Error('DASHSCOPE_API_KEY is required')
  if (mode === 'example' && liveDomainsFor(cases).length && !env.AMAP_MCP_KEY?.trim()) {
    throw new Error('AMAP_MCP_KEY is required for selected navigation/weather cases; no mock fallback')
  }
}

export function createVoiceService(mode = 'example', {
  amapAvailable = Boolean(process.env.AMAP_MCP_KEY?.trim()),
} = {}) {
  if (mode === 'example') {
    const services = createAmapCockpitServices()
    if (!amapAvailable) {
      // Vehicle and music stay testable on their own. A misrouted Amap call fails loudly
      // instead of firing a credential-less request or returning sample data.
      for (const name of Object.keys(services)) {
        services[name] = async () => { throw new Error(`AMAP_MCP_KEY is required for ${name}; no mock fallback`) }
      }
    }
    return new CockpitService({ services })
  }
  if (mode === 'controlled') return createBenchmarkService()
  throw new Error(`Unknown service mode: ${mode}`)
}

// Only the bench instance is wrapped for observation; the example handlers, the MCP
// protocol and the returned payloads are untouched. AsyncLocalStorage attributes
// concurrent business requests to their own tool so turns cannot be mixed up.
export function observeToolExecution(service, { surface, toolLog, clock = () => performance.now() }) {
  const scope = new AsyncLocalStorage()
  const execute = service.execute.bind(service)
  const services = service.services
  service.services = Object.fromEntries(Object.entries(services).map(([name, method]) => [name,
    typeof method !== 'function' ? method : async (...args) => {
      const entry = { name, arguments: structuredClone(args), started_at: clock(), ended_at: null,
        outcome: 'pending', error: null }
      scope.getStore()?.service_calls.push(entry)
      try {
        const result = await method.apply(services, args)
        entry.outcome = result == null || (Array.isArray(result) && !result.length) ? 'empty' : 'returned'
        return result
      } catch (error) {
        entry.outcome = 'threw'
        entry.error = safeMessage(error)
        throw error
      } finally {
        entry.ended_at = clock()
      }
    },
  ]))
  service.execute = async (name, args = {}, options = {}) => {
    const entry = { call_id: randomUUID(), cockpitId: options.cockpitId || 'default', surface,
      name, arguments: structuredClone(args), started_at: clock(), ended_at: null,
      outcome: 'pending', error: null, result_content: null, activities: [], service_calls: [] }
    toolLog.push(entry)
    return scope.run(entry, async () => {
      try {
        const output = await execute(name, args, { ...options, onActivity: event => {
          entry.activities.push({ status: event.status, message: safeMessage(event.message) })
          options.onActivity?.(event)
        } })
        entry.ended_at = clock()
        entry.result_content = safeMessage(output.content)
        const failed = entry.activities.some(event => /(?:failed|not_found|error)$/u.test(event.status || ''))
          || /失败|无法找到|没有找到/u.test(entry.result_content)
        entry.outcome = failed ? 'returned_failure' : 'returned'
        return output
      } catch (error) {
        entry.ended_at = clock()
        entry.outcome = 'threw'
        entry.error = safeMessage(error)
        throw error
      }
    })
  }
  return service
}

export function measuredToolCalls(toolLog, speechEndAt, turnIndex) {
  const offset = at => Number.isFinite(at) && Number.isFinite(speechEndAt)
    ? Math.round((at - speechEndAt) * 10) / 10 : null
  return toolLog.filter(entry => !IGNORED_TOOLS.has(entry.name)).map(entry => ({
    call_id: entry.call_id, turn_index: turnIndex, path: entry.surface,
    name: entry.name, arguments: entry.arguments || {},
    started_ms: offset(entry.started_at), ended_ms: offset(entry.ended_at),
    duration_ms: Number.isFinite(entry.ended_at)
      ? Math.round((entry.ended_at - entry.started_at) * 10) / 10 : null,
    outcome: entry.outcome, error: entry.error, result_content: entry.result_content,
    activities: structuredClone(entry.activities),
    service_calls: entry.service_calls.map(call => ({ name: call.name, arguments: call.arguments,
      started_ms: offset(call.started_at), ended_ms: offset(call.ended_at),
      duration_ms: Number.isFinite(call.ended_at) ? Math.round((call.ended_at - call.started_at) * 10) / 10 : null,
      outcome: call.outcome, error: call.error })),
  }))
}

export function toolTiming(calls) {
  const latest = field => calls.length && calls.every(call => Number.isFinite(call[field]))
    ? Math.max(...calls.map(call => call[field])) : null
  return { before_ms: latest('started_ms'), after_ms: latest('ended_ms') }
}

// Probe the Amap configuration through the real MCP endpoint. A failure stops the run
// instead of substituting sample data for an error or an empty result.
export async function verifyLiveService(origin, surface, domains = ['weather', 'navigation']) {
  const requests = [{ name: 'weather', arguments: { city: '杭州' } },
    { name: 'navigation_start', arguments: { destination: '西湖' } }]
    .filter(request => domains.includes(request.name === 'weather' ? 'weather' : 'navigation'))
  if (!requests.length) return []
  const url = new URL(`/mcp/${surface}`, origin)
  url.searchParams.set('cockpitId', `preflight-${surface}`)
  const client = new Client({ name: 'cockpit-live-preflight', version: '1.0.0' })
  const results = []
  try {
    await client.connect(new StreamableHTTPClientTransport(url))
    for (const request of requests) {
      const response = await client.callTool(request)
      const data = response.structuredContent
      const valid = request.name === 'weather'
        ? data?.weather && !data.weather.raw && (data.weather.dayweather || data.weather.nightweather)
        : data?.navigation?.route?.distance > 0
      if (response.isError || !valid) {
        throw new Error(`Live MCP preflight failed (${request.name}): ${safeMessage(response.content?.[0]?.text || 'empty result')}`)
      }
      results.push({ name: request.name, content: safeMessage(response.content?.[0]?.text), ok: true })
    }
    return results
  } finally {
    await client.close()
  }
}

export function loadCases({ domain, limit, suite = 'short', caseId } = {}) {
  if (!['short', 'synthetic'].includes(suite)) throw new Error(`Unsupported suite: ${suite}`)
  let all = suite === 'short'
    ? routeCasesExpectedPaths(loadBenchmarkCases({ suite: 'short' }), COCKPIT_SURFACE_ROUTING)
    : readFileSync(CASES_URL, 'utf8')
      .split(/\r?\n/u)
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map(line => JSON.parse(line))
  if (caseId) {
    const ids = new Set(String(caseId).split(','))
    all = all.filter(item => ids.has(item.id))
  }
  if (domain && domain !== 'all') {
    const domains = new Set(String(domain).split(',').map(part => part.trim()))
    all = all.filter(caseItem => domains.has(caseItem.domain))
  }
  return limit > 0 ? all.slice(0, limit) : all
}

// ─── Audio simulator (same settings as run-voice.mjs) ────────────────────────
function runProcess(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: options.encoding,
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

async function synthesizeSpeechPcm(text, { sampleRate = SAMPLE_RATE, sayVoice = 'Tingting' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'qwen-cockpit-voice-surface-'))
  const aiffPath = join(root, 'speech.aiff')
  try {
    try {
      runProcess('say', ['-v', sayVoice, '-o', aiffPath, text], { encoding: 'utf8' })
    } catch (error) {
      if (!sayVoice) throw error
      runProcess('say', ['-o', aiffPath, text], { encoding: 'utf8' })
    }
    return runProcess('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-i', aiffPath,
      '-ac', '1', '-ar', String(sampleRate), '-f', 's16le', 'pipe:1',
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function silencePcm(ms, sampleRate = SAMPLE_RATE) {
  return Buffer.alloc(Math.ceil((sampleRate * ms) / 1000) * 2)
}

// ─── Accuracy: gold state built by construction ──────────────────────────────
// Instead of hand-writing 46 expected_final_state blobs, the case's declared
// explicit_calls are replayed on a clean service and the resulting state is the gold
// state. "Correct" then has an executable definition: if the declared tools ran with
// the declared arguments, the state should look like this.
const VOLATILE_STATE_KEYS = new Set(['version', 'updatedAt'])

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .filter(key => !VOLATILE_STATE_KEYS.has(key))
        .sort()
        .map(key => [key, canonical(value[key])]),
    )
  }
  return value
}

function sameState(a, b) {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
}

async function goldStateFor(caseItem, goldService) {
  const cockpitId = `gold-${caseItem.id}`
  goldService.reset(cockpitId)
  for (const call of caseItem.setup_calls || []) {
    await goldService.execute(call.name, call.arguments || {}, { cockpitId })
  }
  // Take a do-nothing baseline first, then apply the declared calls to get the gold
  // state. If the two match, this case cannot discriminate on final state (doing the
  // work looks the same as skipping it). That has to be decided here rather than
  // guessed from tool names, otherwise a missed execution scores as a state match.
  const baseline = goldService.snapshot(cockpitId)
  for (const call of caseItem.explicit_calls || []) {
    await goldService.execute(call.name, call.arguments || {}, { cockpitId })
  }
  const gold = goldService.snapshot(cockpitId)
  return { baseline, gold, discriminating: !sameState(baseline, gold) }
}

// Every declared argument must be present and equal; extra optional arguments the
// model fills in are not errors.
function argsCoverDeclared(declared, actual) {
  for (const [key, expected] of Object.entries(declared || {})) {
    if (JSON.stringify(canonical(expected)) !== JSON.stringify(canonical(actual?.[key]))) {
      return false
    }
  }
  return true
}

async function streamPcm(client, pcm, { sampleRate = SAMPLE_RATE, chunkMs = CHUNK_MS } = {}) {
  const chunkBytes = Math.max(1, Math.round((sampleRate * chunkMs) / 1000)) * 2
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

// ─── Gateway voice session ───────────────────────────────────────────────────
async function openVoiceSession({ gatewayOrigin, sessionId, outputVoice }) {
  const events = []
  const playbackStarted = new Set()
  let resolveReady; let rejectReady; let resolveVoice; let rejectVoice
  const ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej })
  const voiceReady = new Promise((res, rej) => { resolveVoice = res; rejectVoice = rej })
  const wsUrl = new URL('/api/realtime', gatewayOrigin)
  wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:'
  wsUrl.searchParams.set('sessionId', sessionId)

  const client = new GatewayClient({
    url: wsUrl.toString(),
    createSocket: url => new WebSocket(url),
    clientType: 'benchmark',
    clientVersion: '1.0.0',
    clientInstanceId: `voice-surface-${randomUUID()}`,
    clientLabel: 'Smart Cockpit Voice Surface Benchmark',
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
        const error = status.error || new Error('Gateway connection unavailable')
        rejectReady(error); rejectVoice(error)
      }
    },
    onEvent(event) {
      // Stamp every event with the local clock so it can be offset from the zero point.
      events.push({ ...event, at: performance.now() })
      if (event.type === GatewayServerEvent.VOICE_READY) resolveVoice(event)
      if (event.type === GatewayServerEvent.ERROR) {
        rejectVoice(new Error(event.message || event.error?.message || 'Gateway realtime error'))
      }
      const responseId = event.responseId
      if (event.type === GatewayServerEvent.AUDIO_DELTA && responseId
        && !playbackStarted.has(responseId)) {
        playbackStarted.add(responseId)
        client.send({ type: GatewayClientEvent.PLAYBACK_STARTED, responseId })
      }
      if (event.type === GatewayServerEvent.AUDIO_DONE && responseId) {
        if (!playbackStarted.has(responseId)) {
          playbackStarted.add(responseId)
          client.send({ type: GatewayClientEvent.PLAYBACK_STARTED, responseId })
        }
        client.send({ type: GatewayClientEvent.PLAYBACK_ENDED, responseId })
      }
    },
  })
  client.start()
  let timeout
  const readyTimeout = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error('Timed out waiting for Gateway voice readiness')), 30_000)
  })
  try {
    await Promise.race([ready, readyTimeout])
    client.send({ type: GatewayClientEvent.UNMUTE })
    client.send({ type: GatewayClientEvent.INPUT_UNMUTE })
    const readyEvent = await Promise.race([voiceReady, readyTimeout])
    return { client, events, inputSampleRate: readyEvent.inputSampleRate || SAMPLE_RATE }
  } catch (error) {
    client.stop()
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

// ─── Single utterance measurement ────────────────────────────────────────────
async function measureUtterance({
  caseItem, turnIndex = 0, client, events, inputSampleRate, toolLog,
  silenceMs, turnTimeoutMs, settleMs, sayVoice,
}) {
  const speech = await synthesizeSpeechPcm(caseItem.turns[turnIndex].user, {
    sampleRate: inputSampleRate,
    sayVoice,
  })
  const eventStart = events.length
  const toolStart = toolLog.length

  await streamPcm(client, speech, { sampleRate: inputSampleRate, chunkMs: CHUNK_MS })
  // Zero point: the utterance end. The trailing silence is streamed afterwards so the
  // server-side VAD decides the segmentation itself.
  const speechEndAt = performance.now()
  let observationError = null
  try {
    await streamPcm(client, silencePcm(silenceMs, inputSampleRate), {
      sampleRate: inputSampleRate,
      chunkMs: CHUNK_MS,
    })
  } catch (error) {
    // With the zero point known, observed tool times are kept: a connection error must
    // not erase records that already exist.
    observationError = safeMessage(error)
  }

  const deadline = speechEndAt + turnTimeoutMs
  let lastActivityAt = performance.now()
  let sawAssistantAudio = false
  let sawTaskTerminal = false
  let completed = false
  const activeTasks = new Set()
  const activeAudio = new Set()
  let cursor = eventStart

  observation: while (!observationError && performance.now() < deadline) {
    while (cursor < events.length) {
      const event = events[cursor]
      cursor += 1
      lastActivityAt = performance.now()
      if (event.type === GatewayServerEvent.ERROR) {
        observationError = safeMessage(event.message || event.error?.message || 'Gateway realtime error')
        break observation
      }
      if (event.type === GatewayServerEvent.AUDIO_DELTA) activeAudio.add(event.responseId)
      if (event.type === GatewayServerEvent.AUDIO_DONE) {
        sawAssistantAudio = true
        activeAudio.delete(event.responseId)
      }
      const taskId = event.task?.id || event.task?.taskId
      if ([GatewayTaskEvent.ACCEPTED, GatewayTaskEvent.RUNNING, GatewayTaskEvent.DELEGATED].includes(event.type)) {
        activeTasks.add(taskId)
      }
      if (TASK_TERMINAL.has(event.type)) {
        sawTaskTerminal = true
        activeTasks.delete(taskId)
      }
    }
    // On the backend route the tool runs after the reply audio, so the task terminal
    // state has to be awaited.
    const delegated = events.slice(eventStart).some(event => (
      event.type === GatewayServerEvent.TOOL_CALL
      && String(event.name || event.tool || '') === 'spawn_thinking'
    ))
    const currentCalls = toolLog.slice(toolStart)
    const lastToolActivity = Math.max(0, ...currentCalls.map(call => call.ended_at ?? call.started_at))
    const settled = performance.now() - Math.max(lastActivityAt, lastToolActivity) >= settleMs
    const toolsFinished = currentCalls.every(call => Number.isFinite(call.ended_at))
    if (settled && toolsFinished && sawAssistantAudio && activeAudio.size === 0 && activeTasks.size === 0
      && (!delegated || sawTaskTerminal)) {
      completed = true
      break
    }
    await sleep(50)
  }

  const slice = events.slice(eventStart)
  const offsetOf = predicate => {
    const found = slice.find(predicate)
    return found ? Math.round((found.at - speechEndAt) * 10) / 10 : null
  }
  const executedCalls = measuredToolCalls(toolLog.slice(toolStart), speechEndAt, turnIndex)
  const timing = toolTiming(executedCalls)
  const cockpitTool = executedCalls[0]

  // A surface-neutral "this turn is fully done": the last thing still moving in the
  // turn, whichever of reply audio completion, backend task terminal state or tool
  // execution comes last.
  const lastAudioDone = slice.filter(event => event.type === GatewayServerEvent.AUDIO_DONE).at(-1)
  const lastTaskTerminal = slice.filter(event => TASK_TERMINAL.has(event.type)).at(-1)
  const settledCandidates = [
    lastAudioDone?.at,
    lastTaskTerminal?.at,
    Number.isFinite(timing.after_ms) ? speechEndAt + timing.after_ms : null,
  ].filter(value => Number.isFinite(value))

  return {
    id: caseItem.id,
    domain: caseItem.domain,
    turn_index: turnIndex,
    user: caseItem.turns[turnIndex].user,
    timed_out: !completed && !observationError,
    error: observationError,
    timing_schema: 2,
    tool: caseItem.tool,
    expected_tool: caseItem.explicit_calls?.[0]?.name || null,
    executed_tool: cockpitTool?.name || null,
    executed_surface: cockpitTool?.path || null,
    executed_calls: executedCalls,
    tool_before_ms: timing.before_ms,
    tool_after_ms: timing.after_ms,
    transcripts: slice.filter(event => event.type === GatewayServerEvent.TRANSCRIPT_FINAL)
      .map(event => ({ role: event.role, content: event.content })),
    task_events: slice.filter(event => String(event.type).startsWith('task.'))
      .map(event => ({ type: event.type, task_id: event.task?.id || event.task?.taskId,
        at_ms: Math.round((event.at - speechEndAt) * 10) / 10 })),
    last_cockpit_tool_ms: timing.before_ms,
    // All offsets are relative to the utterance end
    user_transcript_ms: offsetOf(event => (
      event.type === GatewayServerEvent.TRANSCRIPT_FINAL && event.role === 'user'
    )),
    gateway_tool_call_ms: offsetOf(event => event.type === GatewayServerEvent.TOOL_CALL),
    cockpit_tool_ms: cockpitTool?.started_ms ?? null,
    first_audio_ms: offsetOf(event => event.type === GatewayServerEvent.AUDIO_DELTA),
    task_completed_ms: offsetOf(event => event.type === GatewayTaskEvent.COMPLETED),
    turn_settled_ms: settledCandidates.length
      ? Math.round((Math.max(...settledCandidates) - speechEndAt) * 10) / 10
      : null,
    assistant_final_ms: offsetOf(event => (
      event.type === GatewayServerEvent.TRANSCRIPT_FINAL
      && event.role === 'assistant'
      && String(event.content || '').trim()
    )),
    delegated: slice.some(event => (
      event.type === GatewayServerEvent.TOOL_CALL
      && String(event.name || event.tool || '') === 'spawn_thinking'
    )),
    // A missed action must distinguish "the model called nothing" from "it called
    // something else", otherwise attribution is guesswork.
    gateway_tools: slice
      .filter(event => event.type === GatewayServerEvent.TOOL_CALL)
      .map(event => String(event.name || event.tool || event.toolName || 'unknown')),
    speech_ms: Math.round(speech.length / 2 / inputSampleRate * 1000),
  }
}

// ─── Statistics ──────────────────────────────────────────────────────────────
function quantile(sorted, ratio) {
  if (!sorted.length) return null
  const position = (sorted.length - 1) * ratio
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

export function summarize(values) {
  const clean = values.filter(value => Number.isFinite(value))
  if (!clean.length) return null
  const sorted = [...clean].sort((a, b) => a - b)
  const round = value => (value == null ? null : Math.round(value * 10) / 10)
  return {
    samples: clean.length,
    min_ms: round(sorted[0]),
    median_ms: round(quantile(sorted, 0.5)),
    p95_ms: round(quantile(sorted, 0.95)),
    max_ms: round(sorted[sorted.length - 1]),
    mean_ms: round(clean.reduce((total, value) => total + value, 0) / clean.length),
  }
}

export function classifyTurn(caseItem, turnIndex) {
  if (caseItem.turns[turnIndex].expect_no_tool) return 'chitchat'
  return caseItem.expected_calls.some(call => call.turn_index === turnIndex)
    ? 'task' : 'no_tool_control'
}

export function scoreCanonicalResult(caseItem, trace, turns, error = null) {
  const score = scoreTrace(caseItem, trace)
  const taskTurns = turns.filter(turn => turn.kind === 'task')
  const allObserved = turns.length === caseItem.turns.length
    && turns.every(turn => !turn.timed_out && !turn.error && Number.isFinite(turn.turn_settled_ms))
  const sum = (items, key) => items.length && items.every(item => Number.isFinite(item[key]))
    ? Math.round(items.reduce((total, item) => total + item[key], 0) * 10) / 10 : null
  const success = score.passed && allObserved && !error
  return {
    id: caseItem.id,
    domain: caseItem.domain,
    tags: caseItem.tags,
    user_turns: caseItem.turns,
    expected_calls: caseItem.expected_calls,
    kind: caseItem.expected_calls.length ? 'task' : 'no_tool_control',
    error,
    task_success: success,
    // Multi-turn cases sum the wait of their task turns, excluding user speech,
    // chitchat and the harness silence confirmation.
    task_turn_wait_sum_ms: allObserved ? sum(taskTurns, 'turn_settled_ms') : null,
    successful_task_wait_ms: success ? sum(taskTurns, 'turn_settled_ms') : null,
    task_action_wait_sum_ms: allObserved ? sum(taskTurns, 'last_cockpit_tool_ms') : null,
    chitchat_wait_sum_ms: sum(turns.filter(turn => turn.kind === 'chitchat'), 'turn_settled_ms'),
    score,
    trace,
    turns,
  }
}

export function hasUnfinishedWork(events, calls) {
  const active = new Set()
  for (const event of events) {
    const id = event.task?.id || event.task?.taskId
    if (!id) continue
    if ([GatewayTaskEvent.ACCEPTED, GatewayTaskEvent.RUNNING, GatewayTaskEvent.DELEGATED].includes(event.type)) active.add(id)
    if (TASK_TERMINAL.has(event.type)) active.delete(id)
  }
  return active.size > 0 || calls.some(call => !Number.isFinite(call.ended_at))
}

async function runCanonicalCases({ cases, surface, serviceMode, serviceServer, gatewayOrigin, cockpitId, toolLog, args,
  silenceMs, turnTimeoutMs, settleMs, sayVoice }) {
  const results = []
  const checkpoint = args.get('checkpoint')
  let blockedBy = null
  if (checkpoint) await mkdir(dirname(resolve(String(checkpoint))), { recursive: true })
  for (const [index, caseItem] of cases.entries()) {
    const sessionId = `short-${surface}-${caseItem.id}-${randomUUID()}`
    const turns = []
    const trace = { id: caseItem.id, calls: [], state_snapshots: [] }
    const caseToolStart = toolLog.length
    let session
    let error = null
    try {
      if (blockedBy) throw new Error(`Not measured: unfinished work from ${blockedBy}; restart in a fresh worker`)
      serviceServer.service.reset(cockpitId)
      for (const call of caseItem.setup_calls || []) {
        await serviceServer.service.execute(call.name, call.arguments || {}, { cockpitId })
      }
      // Same as the original voice bench: one session per case, with its turns sharing
      // that case's context and state.
      session = await openVoiceSession({ gatewayOrigin, sessionId,
        outputVoice: args.get('voice') || process.env.QWEN_AUDIO_REALTIME_VOICE })
      for (const [turnIndex] of caseItem.turns.entries()) {
        const toolStart = toolLog.length
        let measurement
        try {
          measurement = await measureUtterance({ caseItem, turnIndex, ...session, toolLog,
            silenceMs, turnTimeoutMs, settleMs, sayVoice })
        } catch (failure) {
          measurement = { turn_index: turnIndex, user: caseItem.turns[turnIndex].user,
            timing_schema: 2, error: safeMessage(failure),
            executed_calls: measuredToolCalls(toolLog.slice(toolStart), null, turnIndex) }
        }
        measurement.kind = classifyTurn(caseItem, turnIndex)
        measurement.cold_start = turnIndex === 0
        measurement.no_tool_compliant = measurement.executed_calls.length === 0
          && (measurement.gateway_tools || []).length === 0 && !measurement.error && !measurement.timed_out
        turns.push(measurement)
        trace.calls.push(...measurement.executed_calls)
        trace.state_snapshots.push({ turn_index: turnIndex, state: serviceServer.service.snapshot(cockpitId) })
        process.stderr.write(`  [${surface} ${index + 1}/${cases.length}] ${caseItem.id} T${turnIndex + 1}`
          + ` ${measurement.kind} settled=${measurement.turn_settled_ms ?? '-'}ms`
          + ` tools=${measurement.executed_calls.map(call => call.name).join(',') || 'none'}\n`)
        if (measurement.error || measurement.timed_out) {
          error = measurement.error || `Turn ${turnIndex + 1} timed out after ${turnTimeoutMs}ms`
          break
        }
      }
    } catch (failure) {
      error = safeMessage(failure)
    } finally {
      // If an error leaves tools or background tasks running, stop sampling so the
      // shared cockpit state is not polluted.
      if (error && hasUnfinishedWork(session?.events || [], toolLog.slice(caseToolStart))) {
        blockedBy ||= caseItem.id
      }
      session?.client.stop()
      if (!blockedBy) await sleep(500)
    }
    trace.final_state = blockedBy && !session ? null : serviceServer.service.snapshot(cockpitId)
    const result = scoreCanonicalResult(caseItem, trace, turns, error)
    result.session_id = sessionId
    results.push(result)
    if (checkpoint) await appendFile(resolve(String(checkpoint)), `${JSON.stringify(result)}\n`)
    process.stderr.write(`  => ${result.task_success ? 'PASS' : 'FAIL'}${error ? ` ${error}` : ''}\n`)
  }
  const turns = results.flatMap(result => result.turns)
  const taskCases = results.filter(result => result.kind === 'task')
  const chat = turns.filter(turn => turn.kind === 'chitchat')
  return {
    suite: 'short',
    timing_schema: 2,
    service_mode: serviceMode,
    business_services: serviceMode === 'example'
      ? 'example defaults: Amap MCP for places/weather, Amap REST for driving routes; original local music/vehicle handlers'
      : 'controlled benchmark fixtures; no live business API',
    timing_definition: { before: 'max tool started_ms since speech PCM end',
      after: 'max tool ended_ms since speech PCM end, only when every started tool has ended',
      endpoint: 'service.execute start / resolve-or-reject; excludes subsequent MCP response transport and audio',
      failures: 'ended failures included and flagged; not a task-success metric' },
    score_note: serviceMode === 'example' ? 'Original fixture scores are diagnostic only; live data differ from fixed gold state' : null,
    source: ['vehicle.jsonl', 'music.jsonl', 'navigation.jsonl', 'weather.jsonl'],
    surface,
    routing: COCKPIT_SURFACE_ROUTING.domains,
    realtime_model: process.env.QWEN_AUDIO_REALTIME_MODEL,
    agent_model: args.get('agent-model') || process.env.DASHSCOPE_MODEL,
    input: { engine: 'macos_say + ffmpeg', voice: sayVoice, sample_rate: SAMPLE_RATE },
    zero_point: 'speech_end (end of speech PCM, before silence tail)',
    completion_definition: 'last tool execution / task terminal / audio.done received, whichever is last; no physical playback simulation',
    session_policy: 'fresh session per case; first turn cold; no synthetic warmup',
    parameters: { silence_ms: silenceMs, timeout_ms: turnTimeoutMs, settle_ms: settleMs },
    case_count: results.length,
    turn_count: turns.length,
    error_count: results.filter(result => result.error).length,
    official_summary: summarizeScores(results.map(result => result.score)),
    task_case_count: taskCases.length,
    task_success_count: taskCases.filter(result => result.task_success).length,
    task_wait_success: summarize(taskCases.map(result => result.successful_task_wait_ms)),
    chitchat: { count: chat.length, no_tool_count: chat.filter(turn => turn.no_tool_compliant).length,
      wait: summarize(chat.filter(turn => !turn.timed_out && !turn.error).map(turn => turn.turn_settled_ms)) },
    results,
  }
}

// ─── main ────────────────────────────────────────────────────────────────────
async function main() {
  loadCockpitEnvironment()
  const args = parseRunnerArgs(process.argv.slice(2))
  const surface = String(args.get('surface') || 'frontend')
  const suite = String(args.get('suite') || 'short')
  const serviceMode = String(args.get('service-mode') || (suite === 'short' ? 'example' : 'controlled'))
  if (!['example', 'controlled'].includes(serviceMode)) throw new Error(`Unknown service mode: ${serviceMode}`)
  if (suite !== 'short' && serviceMode !== 'controlled') throw new Error('Real services require the short suite')
  if (!['frontend', 'backend'].includes(surface)) throw new Error(`Unknown surface: ${surface}`)
  const domain = args.get('domain') ? String(args.get('domain')) : null
  const limit = Number(args.get('limit') || 0)
  const perSession = numberArg(args, 'per-session', 5)
  const silenceMs = numberArg(args, 'silence-ms', 2_200)
  const turnTimeoutMs = numberArg(args, 'timeout-ms', serviceMode === 'example' ? 120_000 : 60_000)
  const settleMs = numberArg(args, 'settle-ms', 1_200)
  const sayVoice = args.get('say-voice') ? String(args.get('say-voice')) : 'Tingting'
  const cockpitId = `voice-surface-${surface}`
  const cases = loadCases({ domain, limit, suite, caseId: args.get('case-id') })
  if (!cases.length) throw new Error('No cases selected')

  assertVoiceCredentials(cases, serviceMode)
  const liveDomains = liveDomainsFor(cases)

  const runtimeRoot = await mkdtemp(join(tmpdir(), 'qwen-cockpit-voice-surface-bench-'))
  process.env.QWAUDIO_CONFIG_DIR = runtimeRoot
  process.env.QWAUDIO_DATA_DIR = resolve(runtimeRoot, 'data')
  delete process.env.QWEN_AUDIO_FRONTEND_PROFILE
  delete process.env.COCKPIT_FRONTEND_MCP_URL

  let serviceServer; let agentServer; let gatewayRuntime
  const results = []
  const toolLog = []
  try {
    serviceServer = await startCockpitServiceServer({
      service: observeToolExecution(createVoiceService(serviceMode), { surface, toolLog }),
      port: 0,
    })
    process.env.COCKPIT_SERVICE_ORIGIN = serviceServer.origin
    process.env.COCKPIT_ID = cockpitId
    const preflight = serviceMode === 'example' && liveDomains.length
      ? await verifyLiveService(serviceServer.origin, surface, liveDomains) : null
    const preflightCalls = measuredToolCalls(toolLog, null, 0)
    if (preflight) process.stderr.write(`[${surface}] live Amap preflight passed: ${liveDomains.join(', ')}\n`)
    else if (serviceMode === 'example') process.stderr.write(`[${surface}] selected domains do not need Amap; skipping the Amap preflight\n`)

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
    gatewayRuntime = startCockpitGateway({ port: 0, agentCardUrl: agentServer.agentCardUrl })
    if (!gatewayRuntime.server.listening) await once(gatewayRuntime.server, 'listening')
    await gatewayRuntime.agent.start()
    const gatewayOrigin = `http://127.0.0.1:${gatewayRuntime.server.address().port}`

    if (suite === 'short') {
      const report = await runCanonicalCases({ cases, surface, serviceMode, serviceServer, gatewayOrigin, cockpitId,
        toolLog, args, silenceMs, turnTimeoutMs, settleMs, sayVoice })
      report.selected_domains = [...new Set(cases.map(item => item.domain))]
      report.preflight = preflight ? { status: 'passed', domains: liveDomains, results: preflight, calls: preflightCalls }
        : { status: 'skipped', reason: serviceMode === 'example' ? 'selected cases do not require Amap' : 'controlled mode' }
      // Teardown may still log; the entry point prints the report last from main's
      // return value.
      return report
    }

    // The gold state is built on a separate clean service, never on the instance under
    // measurement.
    const goldService = createBenchmarkService()

    for (let index = 0; index < cases.length; index += perSession) {
      const batch = cases.slice(index, index + perSession)
      const sessionId = `voice-surface-${surface}-${index}-${randomUUID()}`
      const session = await openVoiceSession({
        gatewayOrigin,
        sessionId,
        outputVoice: args.get('voice') || process.env.QWEN_AUDIO_REALTIME_VOICE,
      })
      try {
        for (const [position, caseItem] of batch.entries()) {
          serviceServer.service.reset(cockpitId)
          for (const call of caseItem.setup_calls || []) {
            await serviceServer.service.execute(call.name, call.arguments || {}, { cockpitId })
          }
          let measurement
          try {
            measurement = await measureUtterance({
              caseItem,
              client: session.client,
              events: session.events,
              inputSampleRate: session.inputSampleRate,
              toolLog,
              silenceMs,
              turnTimeoutMs,
              settleMs,
              sayVoice,
            })
          } catch (error) {
            measurement = { id: caseItem.id, domain: caseItem.domain, error: error.message }
          }
          // Accuracy is recorded on three independent axes — tool name, declared
          // arguments and final state — and never collapsed into one score.
          if (!measurement.error) {
            const { gold, discriminating } = await goldStateFor(caseItem, goldService)
            const actualState = serviceServer.service.snapshot(cockpitId)
            const declaredArgs = caseItem.explicit_calls?.[0]?.arguments || {}
            const actualArgs = measurement.executed_calls?.[0]?.arguments || null
            measurement.tool_match = measurement.executed_tool === measurement.expected_tool
            measurement.args_match = actualArgs != null
              && argsCoverDeclared(declaredArgs, actualArgs)
            measurement.state_match = sameState(gold, actualState)
            // Cases where doing and skipping look identical cannot discriminate on
            // final state, so they are flagged and excluded from that metric.
            measurement.state_discriminating = discriminating
            // A task truly succeeded when the right tool ran and the world state matches
            // the gold state.
            measurement.task_success = measurement.tool_match && measurement.state_match
          }
          // The first utterance of a session pays for VAD/ASR warmup and must be
          // counted separately from the hot turns.
          measurement.cold_start = position === 0
          measurement.session_id = sessionId
          results.push(measurement)
          process.stderr.write(
            `  [${surface}] ${caseItem.id}`
            + `${measurement.cold_start ? ' (cold)' : ''}`
            + ` tool=${measurement.cockpit_tool_ms ?? 'MISS'}ms`
            + ` settled=${measurement.turn_settled_ms ?? '-'}ms`
            + ` ok=${measurement.task_success ? 'Y' : 'N'}`
            + `${measurement.delegated ? ' delegated' : ''}\n`,
          )
        }
      } finally {
        session.client.stop()
        await sleep(500)
      }
    }
  } finally {
    await gatewayRuntime?.close()
    await agentServer?.close()
    await serviceServer?.close()
    await rm(runtimeRoot, { recursive: true, force: true })
  }

  const hot = results.filter(result => !result.cold_start && !result.error)
  const executed = hot.filter(result => Number.isFinite(result.cockpit_tool_ms))
  const rate = (numerator, denominator) => (
    denominator ? Math.round(numerator / denominator * 1000) / 10 : null
  )
  const discriminating = hot.filter(result => result.state_discriminating)
  const report = {
    surface,
    routing: COCKPIT_SURFACE_ROUTING.domains,
    realtime_model: process.env.QWEN_AUDIO_REALTIME_MODEL || null,
    agent_model: process.env.DASHSCOPE_MODEL || null,
    input: { engine: 'macos_say + ffmpeg', voice: sayVoice, sample_rate: SAMPLE_RATE },
    zero_point: 'speech_end (end of speech PCM, before silence tail)',
    case_count: results.length,
    cold_start_count: results.filter(result => result.cold_start).length,
    error_count: results.filter(result => result.error).length,
    tool_executed_count: executed.length,
    tool_missing_count: hot.length - executed.length,
    delegated_count: hot.filter(result => result.delegated).length,
    accuracy: {
      hot_count: hot.length,
      tool_match: hot.filter(result => result.tool_match).length,
      args_match: hot.filter(result => result.args_match).length,
      state_match: hot.filter(result => result.state_match).length,
      task_success: hot.filter(result => result.task_success).length,
      tool_match_rate: rate(hot.filter(result => result.tool_match).length, hot.length),
      args_match_rate: rate(hot.filter(result => result.args_match).length, hot.length),
      task_success_rate: rate(hot.filter(result => result.task_success).length, hot.length),
      // state_match cannot discriminate for read-only cases, so writes get their own
      // figure.
      state_discriminating_count: discriminating.length,
      state_match_on_writes: discriminating.filter(result => result.state_match).length,
      state_match_rate_on_writes: rate(
        discriminating.filter(result => result.state_match).length,
        discriminating.length,
      ),
    },
    hot: {
      cockpit_tool_ms: summarize(hot.map(result => result.cockpit_tool_ms)),
      first_audio_ms: summarize(hot.map(result => result.first_audio_ms)),
      user_transcript_ms: summarize(hot.map(result => result.user_transcript_ms)),
      task_completed_ms: summarize(hot.map(result => result.task_completed_ms)),
      turn_settled_ms: summarize(hot.map(result => result.turn_settled_ms)),
      // Recompute over successful tasks only, so failed samples cannot pull the latency
      // down.
      cockpit_tool_ms_success_only: summarize(
        hot.filter(result => result.task_success).map(result => result.cockpit_tool_ms),
      ),
      turn_settled_ms_success_only: summarize(
        hot.filter(result => result.task_success).map(result => result.turn_settled_ms),
      ),
    },
    cold: {
      cockpit_tool_ms: summarize(
        results.filter(result => result.cold_start).map(result => result.cockpit_tool_ms),
      ),
      first_audio_ms: summarize(
        results.filter(result => result.cold_start).map(result => result.first_audio_ms),
      ),
    },
    results,
  }
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(report => process.stdout.write(`${JSON.stringify(report)}\n`)).catch(error => {
    process.stderr.write(`${safeMessage(error)}\n`)
    process.exitCode = 1
  })
}
