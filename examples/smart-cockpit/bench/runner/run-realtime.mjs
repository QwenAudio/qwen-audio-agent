#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { loadCockpitEnvironment } from '../../bootstrap/environment.mjs'
import { loadBenchmarkCases, routeCasesExpectedPaths } from '../evaluator/cases.mjs'
import { scoreTrace, summarizeScores } from '../evaluator/score.mjs'

const DEFAULT_SAMPLE_RATE = 16_000
const DEFAULT_CHUNK_MS = 20
const DEFAULT_SILENCE_MS = 2_200
const DEFAULT_TURN_TIMEOUT_MS = 60_000
const DEFAULT_SETTLE_MS = 1_200
const DEFAULT_BETWEEN_CASE_MS = 1_000

function parseRunnerArgs(argv) {
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
  const root = await mkdtemp(join(tmpdir(), 'qwen-cockpit-realtime-turn-'))
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

async function streamPcm(frontend, pcm, {
  sampleRate = DEFAULT_SAMPLE_RATE,
  chunkMs = DEFAULT_CHUNK_MS,
} = {}) {
  const bytesPerSample = 2
  const samplesPerChunk = Math.max(1, Math.round((sampleRate * chunkMs) / 1000))
  const chunkBytes = samplesPerChunk * bytesPerSample
  for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
    const chunk = pcm.subarray(offset, Math.min(offset + chunkBytes, pcm.length))
    frontend.appendAudio(chunk.toString('base64'))
    await new Promise(resolve => setTimeout(resolve, chunkMs))
  }
}

function outputModalities(profile, outputMode = 'text', fallback = ['text']) {
  const capabilities = profile?.modelCapabilities || {}
  if (!profile) return fallback
  const requested = outputMode === 'audio'
    ? ['audio']
    : outputMode === 'both'
      ? ['text', 'audio']
      : ['text']
  const supported = requested.filter(modality => (
    modality === 'text' ? capabilities.textOutput : capabilities.audioOutput
  ))
  if (supported.length) return supported
  return [
    capabilities.textOutput ? 'text' : null,
    capabilities.audioOutput ? 'audio' : null,
  ].filter(Boolean)
}

function defaultOutputModalities(provider) {
  const profile = provider.modelProfile?.() || null
  if (profile) return outputModalities(profile, 'both')
  try {
    const session = provider.buildSession({
      configured: false,
      agentContext: {},
      sessionOptions: {},
    })
    return session.output_modalities || session.modalities || ['audio']
  } catch {
    return ['audio']
  }
}

function sessionTools(tools, session) {
  const sample = session?.tools?.[0]
  if (!sample || sample.function) return tools
  return tools.map(tool => ({
    type: 'function',
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  }))
}

function createControlledProvider(provider, {
  prompt,
  tools,
  outputMode,
  voice,
  defaultModalities,
}) {
  return {
    ...provider,
    buildSession({ configured, sessionOptions = {} } = {}) {
      const session = provider.buildSession({
        configured,
        agentContext: {},
        sessionOptions,
      })
      const profile = provider.modelProfile?.() || null
      const modalities = outputModalities(profile, outputMode, defaultModalities)
      session.instructions = prompt
      session.tools = sessionTools(tools, session)
      if (!configured) {
        if ('output_modalities' in session) session.output_modalities = modalities
        else session.modalities = modalities
        if (modalities.includes('audio')) {
          session.voice = voice || sessionOptions.voice || provider.voice?.()
          session.output_audio_format = 'pcm'
        } else {
          delete session.voice
          delete session.output_audio_format
        }
        if (profile?.transportCapabilities?.audioInput) {
          session.input_audio_format = 'pcm'
        }
        session.turn_detection = profile?.transportCapabilities?.audioInput
          ? profile.sessionDefaults.turnDetection
          : null
      }
      return session
    },
  }
}

function responseOptions(provider, outputMode, defaultModalities) {
  return {
    modalities: outputModalities(provider.modelProfile?.(), outputMode, defaultModalities),
    tool_choice: 'auto',
  }
}

function parseRealtimeArguments(event) {
  const raw = event.arguments
    ?? event.item?.arguments
    ?? event.function?.arguments
    ?? '{}'
  try {
    return JSON.parse(String(raw || '{}'))
  } catch {
    return {}
  }
}

function realtimeFunctionCall(event) {
  if (event?.type !== 'response.function_call_arguments.done') return null
  return {
    callId: event.call_id || event.item?.call_id || event.item_id || event.item?.id || '',
    name: event.name || event.item?.name || event.function?.name || '',
    arguments: parseRealtimeArguments(event),
  }
}

function assistantText(event) {
  if (event?.type === 'response.text.done') return event.text || ''
  if (
    event?.type === 'response.audio_transcript.done'
    || event?.type === 'response.output_audio_transcript.done'
  ) return event.transcript || ''
  return ''
}

function traceEvent(event) {
  const copy = { ...event }
  if (copy.delta && /audio/u.test(copy.type || '')) copy.delta = '<audio>'
  if (copy.audio) copy.audio = '<audio>'
  if (typeof copy.delta === 'string' && copy.delta.length > 200) {
    copy.delta = `${copy.delta.slice(0, 200)}...`
  }
  return copy
}

function eventSummary(event) {
  const text = assistantText(event)
    || event?.transcript
    || event?.text
    || event?.error?.message
    || event?.message
    || ''
  return text ? `${event.type}: ${String(text).slice(0, 80)}` : String(event?.type || 'event')
}

async function waitForTurn(events, startIndex, {
  frontend,
  pendingTools,
  errors,
  sleep,
  timeoutMs = DEFAULT_TURN_TIMEOUT_MS,
  settleMs = DEFAULT_SETTLE_MS,
} = {}) {
  const deadline = Date.now() + timeoutMs
  let cursor = startIndex
  let lastEventAt = Date.now()
  let sawResponseDone = false
  let sawAssistantFinal = false
  while (Date.now() < deadline) {
    while (cursor < events.length) {
      const event = events[cursor]
      cursor += 1
      lastEventAt = Date.now()
      if (event.type === 'error' && !event.__voiceRetried) {
        throw new Error(event.error?.message || event.message || 'Realtime provider error')
      }
      if (event.type === 'response.done') sawResponseDone = true
      if (String(assistantText(event) || '').trim()) sawAssistantFinal = true
    }
    if (errors.length) throw errors[0]
    const realtimeIdle = !frontend.activeResponses.size && !frontend.pendingResponses.length
    const completeEnough = (sawResponseDone || sawAssistantFinal) && realtimeIdle && !pendingTools.size
    if (completeEnough && Date.now() - lastEventAt >= settleMs) return
    await sleep(100)
  }
  const recent = events.slice(Math.max(startIndex, events.length - 12)).map(eventSummary)
  throw new Error(`Timed out waiting for realtime turn. Recent events: ${recent.join(' | ')}`)
}

async function runCase(caseItem, {
  provider,
  RealtimeFrontend,
  harness,
  domains,
  outputMode,
  outputVoice,
  sayVoice,
  silenceMs,
  chunkMs,
  turnTimeoutMs,
  settleMs,
  betweenCaseMs,
}) {
  const service = harness.createBenchmarkService()
  const cockpitId = caseItem.id
  await harness.setupBenchmarkCase(caseItem, { service, cockpitId })

  const calls = []
  const ignoredCalls = []
  const assistantMessages = []
  const stateSnapshots = []
  const events = []
  const errors = []
  const pendingTools = new Set()
  let activeTurnIndex = null
  let frontend

  const defaultModalities = defaultOutputModalities(provider)
  const controlledProvider = createControlledProvider(provider, {
    prompt: harness.cockpitBenchmarkPrompt({ domains }),
    tools: harness.benchmarkTools({ domains }),
    outputMode,
    voice: outputVoice,
    defaultModalities,
  })
  frontend = new RealtimeFrontend({
    provider: controlledProvider,
    agentContext: {},
    sessionOptions: {
      voice: outputVoice,
    },
    onEvent(event) {
      events.push(traceEvent(event))
      const content = String(assistantText(event) || '').trim()
      if (content) assistantMessages.push(content)
      const call = realtimeFunctionCall(event)
      if (!call || activeTurnIndex === null) return
      const task = (async () => {
        try {
          const output = await harness.executeBenchmarkTool({
            service,
            cockpitId,
            calls,
            turnIndex: activeTurnIndex,
            name: call.name,
            args: call.arguments,
          })
          if (call.callId) {
            await frontend.sendFunctionOutput(
              call.callId,
              { content: output?.content || '座舱操作已完成' },
              {},
              { response: responseOptions(provider, outputMode, defaultModalities) },
            )
          }
        } catch (error) {
          if (call.callId) {
            await frontend.sendFunctionOutput(
              call.callId,
              { error: error.message || String(error) },
              {},
              { response: responseOptions(provider, outputMode, defaultModalities) },
            ).catch(() => {})
          }
          errors.push(error)
        }
      })()
      pendingTools.add(task)
      task.finally(() => pendingTools.delete(task))
    },
    onError(error) {
      errors.push(error)
    },
  })

  await frontend.connect()
  try {
    const inputSampleRate = provider.inputSampleRate || DEFAULT_SAMPLE_RATE
    try {
      for (const [turnIndex, turn] of caseItem.turns.entries()) {
        const startIndex = events.length
        activeTurnIndex = turnIndex
        const speech = await synthesizeSpeechPcm(turn.user, {
          sampleRate: inputSampleRate,
          sayVoice,
        })
        await streamPcm(frontend, speech, { sampleRate: inputSampleRate, chunkMs })
        await streamPcm(frontend, silencePcm(silenceMs, inputSampleRate), {
          sampleRate: inputSampleRate,
          chunkMs,
        })
        await waitForTurn(events, startIndex, {
          frontend,
          pendingTools,
          errors,
          sleep: harness.sleep,
          timeoutMs: turnTimeoutMs,
          settleMs,
        })
        stateSnapshots.push({
          turn_index: turnIndex,
          state: service.snapshot(cockpitId),
        })
        activeTurnIndex = null
      }
    } catch (error) {
      assistantMessages.push(`BENCHMARK_ERROR: ${error.message || String(error)}`)
      return {
        id: caseItem.id,
        calls,
        ignored_calls: ignoredCalls,
        assistant_messages: assistantMessages,
        state_snapshots: stateSnapshots,
        realtime_events: events,
        error: {
          message: error.message || String(error),
        },
        final_state: service.snapshot(cockpitId),
      }
    }
    return {
      id: caseItem.id,
      calls,
      ignored_calls: ignoredCalls,
      assistant_messages: assistantMessages,
      state_snapshots: stateSnapshots,
      realtime_events: events,
      final_state: service.snapshot(cockpitId),
    }
  } finally {
    activeTurnIndex = null
    frontend.close()
    await harness.sleep(betweenCaseMs)
  }
}

async function main() {
  const args = parseRunnerArgs(process.argv.slice(2))
  loadCockpitEnvironment()
  if (args.get('realtime-provider')) {
    process.env.QWEN_AUDIO_REALTIME_PROVIDER = String(args.get('realtime-provider'))
  }
  if (args.get('realtime-model')) {
    process.env.QWEN_AUDIO_REALTIME_MODEL = String(args.get('realtime-model'))
  }

  const harness = await import('./controlled-harness.mjs')
  const { COCKPIT_SURFACE_ROUTING } = await import('../../service/tools/registry.mjs')
  const { RealtimeFrontend } = await import('../../../../server/src/voice/realtime-provider.mjs')
  const { resolveRealtimeProvider } = await import('../../../../server/src/voice/providers/registry.mjs')
  const provider = resolveRealtimeProvider(args.get('realtime-provider'))
  const limit = Number(args.get('limit') || 0)
  const caseId = args.get('case-id')
  const requestedDomains = args.get('domain')
    ? String(args.get('domain')).split(',').map(item => item.trim()).filter(Boolean)
    : harness.BENCHMARK_DOMAINS
  const suite = String(args.get('suite') || 'short')
  const domains = suite === 'short' ? requestedDomains : harness.BENCHMARK_DOMAINS
  const outputMode = String(args.get('output') || 'text')
  if (!['text', 'audio', 'both'].includes(outputMode)) {
    throw new Error('--output must be text, audio, or both')
  }

  let cases = routeCasesExpectedPaths(loadBenchmarkCases({ domains: requestedDomains, suite }), COCKPIT_SURFACE_ROUTING)
  if (caseId) cases = cases.filter(item => item.id === caseId)
  if (limit > 0) cases = cases.slice(0, limit)
  if (!cases.length) throw new Error('No benchmark cases selected')

  const traces = []
  for (const [index, caseItem] of cases.entries()) {
    process.stderr.write(`[${index + 1}/${cases.length}] ${caseItem.id}\n`)
    traces.push(await runCase(caseItem, {
      provider,
      RealtimeFrontend,
      harness,
      domains,
      outputMode,
      outputVoice: args.get('voice') || process.env.QWEN_AUDIO_OUTPUT_VOICE,
      sayVoice: args.get('say-voice') === true ? undefined : args.get('say-voice') || 'Ting-Ting',
      silenceMs: harness.numberArg(args, 'silence-ms', DEFAULT_SILENCE_MS),
      chunkMs: harness.numberArg(args, 'chunk-ms', DEFAULT_CHUNK_MS),
      turnTimeoutMs: harness.numberArg(args, 'timeout-ms', DEFAULT_TURN_TIMEOUT_MS),
      settleMs: harness.numberArg(args, 'settle-ms', DEFAULT_SETTLE_MS),
      betweenCaseMs: harness.numberArg(args, 'between-case-ms', DEFAULT_BETWEEN_CASE_MS),
    }))
  }

  const scores = cases.map((caseItem, index) => scoreTrace(caseItem, traces[index]))
  const report = {
    suite: 'smart-cockpit/cockpit',
    mode: 'realtime',
    benchmark_suite: suite,
    domains,
    realtime_provider: provider.key,
    realtime_model: provider.model(),
    output_mode: outputMode,
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
    || 'examples/smart-cockpit/bench/reports/cockpit-realtime-latest.json'
  const absolute = resolve(String(outPath))
  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(absolute, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report.summary, null, 2))
  console.log(`report: ${absolute}`)
}

main().catch(error => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
