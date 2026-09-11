#!/usr/bin/env node
// Frontend/backend latency comparison under audio input. The same spoken
// commands are routed twice:
//   frontend — realtime-api calls the cockpit tools directly
//   backend  — realtime-api delegates to the A2A Agent through spawn_thinking
// Both runs share the same cases, the same audio simulator (macOS say + ffmpeg)
// and the same zero point (the end of the utterance).
//
// Usage:
//   export DASHSCOPE_API_KEY=...
//   node run-voice-surface-compare.mjs                       # all 46 cases
//   node run-voice-surface-compare.mjs --domain vehicle       # vehicle only
//   node run-voice-surface-compare.mjs --limit 8 --per-session 4
//
// The two surfaces run *serially*, never in parallel: in parallel they would
// compete for the same realtime quota and local CPU, so the measured difference
// would reflect resource contention instead of the architecture.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { summarizeScores } from '../evaluator/score.mjs'
import { summarize, toolTiming, loadCases, assertVoiceCredentials } from './voice-surface-worker.mjs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { loadCockpitEnvironment } from '../../bootstrap/environment.mjs'

const WORKER_URL = new URL('./voice-surface-worker.mjs', import.meta.url)
const COMPARED_DOMAINS = ['vehicle', 'music', 'navigation', 'weather']

function parseArgs(argv) {
  const args = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index]
    if (!raw.startsWith('--')) continue
    const key = raw.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) { args.set(key, true); continue }
    args.set(key, next); index += 1
  }
  return args
}

function runWorker(surface, passthrough) {
  const args = [fileURLToPath(WORKER_URL), '--surface', surface, ...passthrough]
  // Surfaces are routed per domain, so vehicle/music/navigation can only move to
  // the backend by flipping the whole domain.
  const domains = Object.fromEntries(COMPARED_DOMAINS.map(domain => [domain, surface]))
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, COCKPIT_DOMAIN_SURFACES: JSON.stringify({ domains }) },
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.once('error', rejectPromise)
    child.once('close', code => {
      if (code !== 0) {
        rejectPromise(new Error(`voice surface worker (${surface}) exited with code ${code}`))
        return
      }
      const line = stdout.trim().split(/\r?\n/u).at(-1)
      try {
        resolvePromise(JSON.parse(line))
      } catch (error) {
        rejectPromise(new Error(`voice surface worker (${surface}) produced no report: ${error.message}`))
      }
    })
  })
}

function toolTurn(result, turnIndex) {
  const turn = result.turns.find(item => item.turn_index === turnIndex)
  const calls = turn?.executed_calls
    || (result.trace?.calls || []).filter(call => call.turn_index === turnIndex)
  const timestamps = calls.map(call => call.completed_ms)
  const lastToolMs = calls.length && timestamps.every(Number.isFinite)
    ? Math.max(...timestamps)
    : calls.length && Number.isFinite(turn?.last_cockpit_tool_ms) ? turn.last_cockpit_tool_ms : null
  return { turn, calls, lastToolMs,
    error: turn?.error || (turn?.timed_out ? 'observation timed out' : null)
      || (!turn ? result.error || 'turn not observed' : null) }
}

export function buildCanonicalComparison(frontend, backend) {
  if ((frontend.timing_schema || 1) !== (backend.timing_schema || 1)
    || (frontend.service_mode || 'controlled') !== (backend.service_mode || 'controlled')) {
    throw new Error('Frontend/backend timing schemas or business service modes differ')
  }
  const back = new Map(backend.results.map(result => [result.id, result]))
  const frontIds = new Set(frontend.results.map(result => result.id))
  if (frontIds.size !== frontend.results.length || back.size !== backend.results.length
    || frontend.results.length !== back.size || frontend.results.some(result => !back.has(result.id))) {
    throw new Error('Frontend/backend case IDs differ or contain duplicates')
  }
  for (const f of frontend.results) {
    const b = back.get(f.id)
    if (JSON.stringify(f.user_turns) !== JSON.stringify(b.user_turns)
      || JSON.stringify(f.expected_calls.map(({ path: _path, ...call }) => call))
        !== JSON.stringify(b.expected_calls.map(({ path: _path, ...call }) => call))) {
      throw new Error(`Frontend/backend turns or gold calls differ: ${f.id}`)
    }
  }
  if (frontend.timing_schema === 2) return buildDualComparison(frontend, backend)
  const mean = values => {
    const valid = values.filter(Number.isFinite)
    return valid.length ? Math.round(valid.reduce((sum, value) => sum + value, 0) / valid.length * 10) / 10 : null
  }
  const tasks = frontend.results.flatMap(f => f.user_turns.flatMap((turn, index) => {
    if (turn.expect_no_tool || !f.expected_calls.some(call => call.turn_index === index)) return []
    const b = back.get(f.id)
    const aTurn = toolTurn(f, index)
    const bTurn = toolTurn(b, index)
    return [{ id: f.id, turn_index: index, domain: f.domain, task: turn.user,
      frontend_ms: aTurn.lastToolMs, backend_ms: bTurn.lastToolMs,
      frontend_tools: aTurn.calls.map(call => call.name), backend_tools: bTurn.calls.map(call => call.name),
      frontend_error: aTurn.error, backend_error: bTurn.error }]
  }))
  const controls = kind => frontend.results.flatMap(f => f.user_turns.flatMap((turn, index) => {
    const expectedKind = turn.expect_no_tool ? 'chitchat'
      : f.expected_calls.some(call => call.turn_index === index) ? 'task' : 'no_tool_control'
    if (expectedKind !== kind) return []
    const a = toolTurn(f, index)
    const b = toolTurn(back.get(f.id), index)
    return [{ id: f.id, turn_index: index, user: turn.user,
      frontend_no_tool: Boolean(a.turn?.no_tool_compliant), backend_no_tool: Boolean(b.turn?.no_tool_compliant),
      frontend_tools: a.calls.map(call => call.name), backend_tools: b.calls.map(call => call.name),
      frontend_gateway_tools: a.turn?.gateway_tools || [], backend_gateway_tools: b.turn?.gateway_tools || [],
      frontend_error: a.error, backend_error: b.error }]
  }))
  const groups = ['all', ...new Set(tasks.map(row => row.domain))].map(domain => {
    const rows = tasks.filter(row => domain === 'all' || row.domain === domain)
    const frontTimes = rows.map(row => row.frontend_ms).filter(Number.isFinite)
    const backTimes = rows.map(row => row.backend_ms).filter(Number.isFinite)
    return { domain, total: rows.length,
      frontend_count: frontTimes.length, backend_count: backTimes.length,
      frontend_mean_ms: mean(frontTimes), backend_mean_ms: mean(backTimes) }
  })
  return { metric: 'speech_end_to_last_cockpit_tool_execution', unit: 'task_turn',
    mean_policy: 'all finite tool timestamps per surface independently; no tool-matching, case-level or audio gate; missing timestamps excluded, never zero-filled',
    tasks, chitchat: controls('chitchat'), no_tool_controls: controls('no_tool_control'), groups }
}

function buildDualComparison(frontend, backend) {
  const back = new Map(backend.results.map(result => [result.id, result]))
  const tasks = []; const chitchat = []; const noTool = []
  const difference = (a, b) => Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) * 10) / 10 : null
  for (const f of frontend.results) {
    for (const [index, input] of f.user_turns.entries()) {
      const row = { id: f.id, domain: f.domain, turn_index: index, task: input.user }
      for (const [surface, result] of [['frontend', f], ['backend', back.get(f.id)]]) {
        const turn = result.turns.find(item => item.turn_index === index)
        const calls = turn?.executed_calls || []
        const timing = toolTiming(calls)
        row[`${surface}_before_ms`] = timing.before_ms
        row[`${surface}_after_ms`] = timing.after_ms
        row[`${surface}_tools`] = calls.map(call => call.name)
        row[`${surface}_outcomes`] = calls.map(call => call.outcome || 'unknown')
        row[`${surface}_failure_count`] = calls.filter(call => ['threw', 'returned_failure'].includes(call.outcome)).length
        row[`${surface}_service_call_count`] = calls.reduce((n, call) => n + (call.service_calls?.length || 0), 0)
        row[`${surface}_gateway_tools`] = turn?.gateway_tools || []
        row[`${surface}_error`] = [turn?.error || (turn?.timed_out ? 'observation timed out' : null)
          || (!turn ? result.error || 'turn not observed' : null),
        ...calls.filter(call => ['threw', 'returned_failure'].includes(call.outcome))
          .map(call => `${call.name}: ${call.error || call.result_content || call.outcome}`)].filter(Boolean).join('; ') || null
      }
      row.before_difference_ms = difference(row.frontend_before_ms, row.backend_before_ms)
      row.after_difference_ms = difference(row.frontend_after_ms, row.backend_after_ms)
      const target = input.expect_no_tool ? chitchat
        : f.expected_calls.some(call => call.turn_index === index) ? tasks : noTool
      target.push(row)
    }
  }
  const groups = ['all', ...new Set(tasks.map(row => row.domain))].map(domain => {
    const rows = tasks.filter(row => domain === 'all' || row.domain === domain)
    const group = { domain, total: rows.length }
    for (const surface of ['frontend', 'backend']) {
      for (const phase of ['before', 'after']) {
        const times = rows.map(row => row[`${surface}_${phase}_ms`]).filter(Number.isFinite)
        group[`${surface}_${phase}_count`] = times.length
        group[`${surface}_${phase}_mean_ms`] = times.length
          ? Math.round(times.reduce((sum, time) => sum + time, 0) / times.length * 10) / 10 : null
      }
      group[`${surface}_failure_turn_count`] = rows.filter(row => row[`${surface}_failure_count`] > 0).length
    }
    for (const phase of ['before', 'after']) {
      group[`${phase}_difference_ms`] = difference(group[`frontend_${phase}_mean_ms`], group[`backend_${phase}_mean_ms`])
    }
    return group
  })
  return { timing_schema: 2, service_mode: frontend.service_mode, unit: 'task_turn',
    metric: 'speech_end_to_tool_start_and_end',
    mean_policy: 'all finite per-surface timestamps independently, including failed returns; no tool-matching or audio gate',
    before_definition: 'latest service.execute start within the turn',
    after_definition: 'latest service.execute resolve/reject, only if all invoked tools ended; not audio or A2A completion',
    tasks, chitchat, no_tool_controls: noTool, groups }
}

export function mergeRecovery(previous, retried) {
  if ((previous.timing_schema || 1) !== (retried.timing_schema || 1)
    || (previous.service_mode || 'controlled') !== (retried.service_mode || 'controlled')) {
    throw new Error('Recovery timing schemas or business service modes differ')
  }
  const replacements = new Map(retried.results.map(result => [result.id, result]))
  for (const id of replacements.keys()) {
    if (!previous.results.find(result => result.id === id)?.error) {
      throw new Error(`Recovery may only replace execution errors, not model scoring failures: ${id}`)
    }
  }
  const results = previous.results.map(result => replacements.has(result.id)
    ? { ...replacements.get(result.id), previous_attempt: result } : result)
  const turns = results.flatMap(result => result.turns)
  const tasks = results.filter(result => result.kind === 'task')
  const chat = turns.filter(turn => turn.kind === 'chitchat')
  return { ...previous, results,
    recovery_ids: [...replacements.keys()],
    turn_count: turns.length,
    error_count: results.filter(result => result.error).length,
    official_summary: summarizeScores(results.map(result => result.score)),
    task_success_count: tasks.filter(result => result.task_success).length,
    task_wait_success: summarize(tasks.map(result => result.successful_task_wait_ms)),
    chitchat: { count: chat.length, no_tool_count: chat.filter(turn => turn.no_tool_compliant).length,
      wait: summarize(chat.filter(turn => !turn.timed_out && !turn.error).map(turn => turn.turn_settled_ms)) } }
}

export async function writeCanonicalTables(report, absolute) {
  if (report.comparison.timing_schema === 2) return writeDualTables(report, absolute)
  const comparison = report.comparison
  const esc = value => String(value ?? '').replace(/[&<>"']/gu,
    char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
  const table = (headers, rows) => `<table><thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>`
    + `<tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${esc(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`
  const seconds = value => Number.isFinite(value) ? (value / 1000).toFixed(3) : '—'
  const taskHeaders = ['ID', 'Domain', 'Turn', 'Utterance', 'Frontend tool response/s', 'Backend tool response/s',
    'Frontend tools called', 'Backend tools called', 'Observation error']
  const taskRows = comparison.tasks.map(row => [row.id, row.domain, `turn ${row.turn_index + 1}`, row.task,
    seconds(row.frontend_ms), seconds(row.backend_ms), row.frontend_tools.join(', '), row.backend_tools.join(', '),
    [row.frontend_error && `frontend: ${row.frontend_error}`, row.backend_error && `backend: ${row.backend_error}`]
      .filter(Boolean).join('; ')])
  const controlHeaders = ['ID/turn', 'Utterance', 'Frontend cockpit tools', 'Backend cockpit tools',
    'Frontend gateway tools', 'Backend gateway tools']
  const controlRows = rows => rows.map(row => [`${row.id}/T${row.turn_index + 1}`, row.user,
    row.frontend_tools.join(', '), row.backend_tools.join(', '),
    row.frontend_gateway_tools.join(', '), row.backend_gateway_tools.join(', ')])
  const summary = comparison.groups.map(g => [g.domain, g.total,
    g.frontend_count, g.backend_count, seconds(g.frontend_mean_ms), seconds(g.backend_mean_ms)])
  const html = '<!doctype html><html lang="en"><meta charset="utf-8"><title>Short per-turn tool response latency</title>'
    + '<style>body{font:15px system-ui;margin:32px;color:#18212f}table{border-collapse:collapse;margin:20px 0;width:100%}td,th{border:1px solid #ddd;padding:8px;text-align:left}th{background:#edf2f7}tr:nth-child(even){background:#fafafa}td:first-child{font:12px monospace}</style>'
    + '<h1>Bundled short suite: per-turn cockpit tool response latency</h1>'
    + '<p>Every turn is timed on its own: the last cockpit tool execution in the turn minus the moment its speech PCM finished streaming. audio.done, backend task terminal states and confirmation windows are excluded. Turns of one case share the original context, but each task turn is a separate row and enters the mean independently instead of being summed into a case duration; the cold first turn is kept.</p>'
    + '<p>Only time is reported. Nothing is filtered by tool-call correctness or case score. Each surface averages all of its own timeable responses without requiring the other surface to have a timestamp, so the timeable samples may differ and both counts are listed, preserving the real long tail. Domains follow the original task domain and do not change with the tools actually called.</p>'
    + '<p>Wrong tools, bad arguments and repeated calls keep their real execution latency. A tool that was never called, or whose timestamp is missing, shows — instead of a zero and never falls back to the audio end. Observation errors are kept, and an existing tool timestamp survives an audio wait timeout.</p>'
    + '<p>Chitchat and clarification/refusal turns list their raw calls separately and never enter the task latency mean. The original scores stay in the JSON; they are neither shown in this latency table nor used to filter it.</p>'
    + (report.reanalysis ? `<p>Offline recomputation of ${esc(report.reanalysis.source)}. The measured audio timestamps are reused, no model was called again and the source report is unchanged.</p>` : '')
    + (report.recovery ? `<p>Source includes connection/timeout recovery: ${esc(report.recovery.frontend_ids.join(', ')) || 'none'} (frontend); ${esc(report.recovery.backend_ids.join(', ')) || 'none'} (backend). Original attempts are kept and plain scoring failures were not retried.</p>` : '')
    + '<h2>Mean tool latency per response</h2>' + table(['Domain', 'Task turns', 'Frontend timeable', 'Backend timeable', 'Frontend mean/s', 'Backend mean/s'], summary)
    + '<h2>Per-turn responses</h2>' + table(taskHeaders, taskRows)
    + '<h2>Chitchat (frontend should answer directly)</h2>' + table(controlHeaders, controlRows(comparison.chitchat))
    + '<h2>Clarification/refusal: no tool expected</h2>' + table(controlHeaders, controlRows(comparison.no_tool_controls)) + '</html>'
  const csv = rows => '\ufeff' + rows.map(row => row.map(value => `"${String(value ?? '').replaceAll('"', '""')}"`).join(',')).join('\n') + '\n'
  await writeFile(`${absolute}.html`, html)
  await writeFile(`${absolute}.tasks.csv`, csv([taskHeaders, ...taskRows]))
  await writeFile(`${absolute}.chitchat.csv`, csv([controlHeaders, ...controlRows(comparison.chitchat)]))
  await writeFile(`${absolute}.no-tool.csv`, csv([controlHeaders, ...controlRows(comparison.no_tool_controls)]))
}

async function writeDualTables(report, absolute) {
  const c = report.comparison
  const seconds = ms => Number.isFinite(ms) ? (ms / 1000).toFixed(3) : '—'
  const esc = value => String(value ?? '').replace(/[&<>"']/gu,
    char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
  const table = (heads, rows) => '<table><thead><tr>' + heads.map(h => `<th>${esc(h)}</th>`).join('')
    + '</tr></thead><tbody>' + rows.map(row => '<tr>' + row.map(v => `<td>${esc(v)}</td>`).join('') + '</tr>').join('') + '</tbody></table>'
  const csv = (heads, rows) => '\ufeff' + [heads, ...rows].map(row => row
    .map(value => `"${String(value ?? '').replaceAll('"', '""')}"`).join(',')).join('\n') + '\n'
  const phases = [['before', 'Before execution'], ['after', 'After execution']].map(([key, label]) => ({
    key, label,
    summaryHeads: ['Domain', 'Task turns', `Frontend ${key}/s`, `Backend ${key}/s`,
      'Difference (backend − frontend)/s', 'Frontend valid', 'Backend valid'],
    summaryRows: c.groups.map(g => [g.domain, g.total,
      seconds(g[`frontend_${key}_mean_ms`]), seconds(g[`backend_${key}_mean_ms`]), seconds(g[`${key}_difference_ms`]),
      g[`frontend_${key}_count`], g[`backend_${key}_count`]]),
    taskHeads: ['ID', 'Domain', 'Turn', 'Utterance', `Frontend ${key}/s`, `Backend ${key}/s`,
      'Difference (backend − frontend)/s'],
    taskRows: c.tasks.map(r => [r.id, r.domain, `turn ${r.turn_index + 1}`, r.task,
      seconds(r[`frontend_${key}_ms`]), seconds(r[`backend_${key}_ms`]), seconds(r[`${key}_difference_ms`])]),
  }))
  const markdownTable = (heads, rows) => [heads, heads.map(() => '---'), ...rows]
    .map(row => '| ' + row.map(value => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ')).join(' | ') + ' |').join('\n')
  const source = c.service_mode === 'example'
    ? 'Same business path as a normal example run: navigation places and weather use the real Amap MCP, driving routes use the real Amap REST API, while music and vehicle keep the example handlers. No fixed route or canned weather was injected.'
    : 'This report uses controlled simulated business data and does not represent the real Amap service.'
  const notes = [source,
    `Realtime model: ${report.realtime_model}; backend model: ${report.agent_model}.`,
    'Unit: seconds. Before = speech PCM end to the latest service.execute start in the turn; after = the same zero point to the latest resolve/reject once every invoked tool has finished. Neither includes the following MCP response transport, the reply audio or backend task terminal states, and neither means the physical action completed.',
    'Turns count independently and the cold first turn is kept. With several tools in one turn the latest start and latest end are used rather than summed, so the two endpoints may belong to different concurrent tools. Each surface averages its own timestamped responses without filtering on tool match or outcome; the difference is backend minus frontend.',
    'A turn with no tool call or a missing timestamp shows — and is never counted as zero. Failed returns are still timed, so an after value does not imply business success. The surfaces may hold different samples, so read the valid counts as well, especially for small domains.',
    `${c.tasks.length} task turns; ${c.chitchat.length} chitchat turns and ${c.no_tool_controls.length} clarification/refusal turns stay in the data without entering the task means. Scores, transcripts, tool payloads and process logs are not shown.`,
  ]
  if (report.recovery) notes.push('This report includes connection/timeout recovery; the original timing attempts are kept in the data.')
  if (report.batch_sources) {
    notes.push('Batch sources: this is an offline merge of per-domain runs measured at different times, not one continuous run. Means are recomputed from the responses instead of averaging batch means.')
    for (const batch of report.batch_sources) notes.push(`${basename(batch.source)}; ${batch.created_at}; ${batch.case_ids.length} cases; ${batch.recovery ? 'with recovery' : 'no recovery'}.`)
  }
  const stem = basename(absolute)
  const html = '<!doctype html><html lang="en"><meta charset="utf-8"><title>Short frontend/backend tool latency</title>'
    + '<style>body{font:15px system-ui;margin:32px;color:#18212f}table{border-collapse:collapse;margin:20px 0;width:100%}th,td{border:1px solid #ddd;padding:8px;text-align:left}th{background:#edf2f7}</style>'
    + '<h1>Short frontend/backend tool latency</h1>' + notes.map(note => `<p>${esc(note)}</p>`).join('')
    + phases.map(p => `<h2>${p.label}</h2>` + table(p.summaryHeads, p.summaryRows)
      + `<p><a href="${esc(encodeURIComponent(`${stem}.${p.key}.csv`))}">Per-turn CSV, ${p.label.toLowerCase()}</a></p>`).join('') + '</html>\n'
  const markdown = '# Short frontend/backend tool latency\n\n' + notes.join('\n\n') + '\n\n'
    + phases.map(p => `## ${p.label}\n\n${markdownTable(p.summaryHeads, p.summaryRows)}\n\n`
      + `[Per-turn CSV, ${p.label.toLowerCase()}](${encodeURIComponent(`${stem}.${p.key}.csv`)})`).join('\n\n') + '\n'
  await writeFile(`${absolute}.html`, html)
  await writeFile(`${absolute}.md`, markdown)
  for (const phase of phases) {
    await writeFile(`${absolute}.${phase.key}.summary.csv`, csv(phase.summaryHeads, phase.summaryRows))
    await writeFile(`${absolute}.${phase.key}.csv`, csv(phase.taskHeads, phase.taskRows))
  }
}

function fmt(value, unit = 'ms') {
  return value == null ? '—' : `${Math.round(value)}${unit}`
}

function printComparison(frontend, backend) {
  const line = '─'.repeat(78)
  console.log(`\n┌${line}┐`)
  console.log('│  Frontend/backend latency under audio input (zero = end of utterance)'.padEnd(79) + '│')
  console.log(`├${line}┤`)
  console.log(`│  input: ${frontend.input.engine} / ${frontend.input.voice} / ${frontend.input.sample_rate}Hz`.padEnd(79) + '│')
  console.log(`│  realtime: ${frontend.realtime_model || 'default'}   agent: ${frontend.agent_model || 'default'}`.padEnd(79) + '│')
  console.log(`└${line}┘`)

  const rows = [
    ['utterance end → final ASR', 'user_transcript_ms'],
    ['utterance end → first reply audio', 'first_audio_ms'],
    ['utterance end → cockpit action', 'cockpit_tool_ms'],
    ['utterance end → turn fully settled', 'turn_settled_ms'],
    ['↑ successful cases only', 'turn_settled_ms_success_only'],
    ['utterance end → backend task done', 'task_completed_ms'],
  ]

  console.log('\nHot turns (the first utterance of each session is excluded as VAD/ASR warmup):')
  console.log('┌───────────────────────────────────┬────────────┬────────────┬────────────┐')
  console.log('│ Metric                            │  Frontend  │  Backend   │     Δ      │')
  console.log('├───────────────────────────────────┼────────────┼────────────┼────────────┤')
  for (const [label, key] of rows) {
    const a = frontend.hot[key]?.median_ms
    const b = backend.hot[key]?.median_ms
    const delta = a != null && b != null ? b - a : null
    const sign = delta != null && delta >= 0 ? '+' : ''
    console.log(
      `│ ${label.padEnd(33 - (label.length - [...label].length))} │ ${fmt(a).padStart(10)} │ ${fmt(b).padStart(10)} │ `
      + `${(delta == null ? '—' : sign + fmt(delta)).padStart(10)} │`,
    )
  }
  console.log('└───────────────────────────────────┴────────────┴────────────┴────────────┘')

  const toolA = frontend.hot.cockpit_tool_ms?.median_ms
  const toolB = backend.hot.cockpit_tool_ms?.median_ms
  if (toolA && toolB) {
    console.log(`\n  cockpit action latency ratio: ${(toolB / toolA).toFixed(2)}x (backend / frontend)`)
  }
  const settleA = frontend.hot.turn_settled_ms?.median_ms
  const settleB = backend.hot.turn_settled_ms?.median_ms
  if (settleA && settleB) {
    console.log(`  turn settle latency ratio: ${(settleB / settleA).toFixed(2)}x (backend / frontend)`)
  }

  console.log('\nAccuracy (hot turns):')
  console.log('┌────────────┬────────┬────────────┬────────────┬────────────┬────────────┐')
  console.log('│ Surface    │ Sample │ Tool match │ Args match │ State (wr) │ Task done  │')
  console.log('├────────────┼────────┼────────────┼────────────┼────────────┼────────────┤')
  for (const report of [frontend, backend]) {
    const a = report.accuracy
    const pct = (hit, total, value) => `${hit}/${total} ${value == null ? '' : `${value}%`}`.trim()
    console.log(
      `│ ${report.surface.padEnd(10)} │ ${String(a.hot_count).padStart(6)} │ `
      + `${pct(a.tool_match, a.hot_count, a.tool_match_rate).padStart(10)} │ `
      + `${pct(a.args_match, a.hot_count, a.args_match_rate).padStart(10)} │ `
      + `${pct(a.state_match_on_writes, a.state_discriminating_count, a.state_match_rate_on_writes).padStart(10)} │ `
      + `${pct(a.task_success, a.hot_count, a.task_success_rate).padStart(10)} │`,
    )
  }
  console.log('└────────────┴────────┴────────────┴────────────┴────────────┴────────────┘')
  console.log('  Task done = the right tool was called and the final state matches the gold')
  console.log('  state, which is built by replaying the case\'s explicit_calls on a clean')
  console.log('  service rather than hand-annotated.')
  console.log('  State (wr) covers write cases only: read-only tools cannot change state and')
  console.log('  would inflate the rate.')

  console.log('\nExecution reliability:')
  console.log('┌────────────┬────────────┬────────────┬────────────┬────────────┐')
  console.log('│ Surface    │ Cases      │ Executed   │ Not fired  │ Delegated  │')
  console.log('├────────────┼────────────┼────────────┼────────────┼────────────┤')
  for (const report of [frontend, backend]) {
    console.log(
      `│ ${report.surface.padEnd(10)} │ ${String(report.case_count).padStart(10)} │ `
      + `${String(report.tool_executed_count).padStart(10)} │ `
      + `${String(report.tool_missing_count).padStart(10)} │ `
      + `${String(report.delegated_count).padStart(10)} │`,
    )
  }
  console.log('└────────────┴────────────┴────────────┴────────────┴────────────┘')

  console.log('\nCold start (first utterance of each session, VAD/ASR warmup included):')
  for (const report of [frontend, backend]) {
    console.log(
      `  ${report.surface.padEnd(9)} action=${fmt(report.cold.cockpit_tool_ms?.median_ms)}`
      + `  first audio=${fmt(report.cold.first_audio_ms?.median_ms)}`,
    )
  }

  console.log('\n  Note: the backend usually starts replying earlier than the frontend because')
  console.log('  it plays a placeholder such as "working on it" before executing, while the')
  console.log('  action itself waits for a separate A2A Agent inference. It sounds faster and')
  console.log('  acts slower, so surface placement should be judged on the action latency.')
}

// Offline merge of per-domain batches: sources are kept, and legacy
// instrumentation or different run configurations are never mixed in.
export function combineReports(batches) {
  if (batches.length < 2) throw new Error('At least two batch reports are required')
  const metadata = ['suite', 'timing_schema', 'service_mode', 'business_services', 'timing_definition',
    'realtime_model', 'agent_model', 'input', 'zero_point', 'parameters', 'session_policy', 'routing']
  for (const { report } of batches) {
    if (report.suite !== 'short' || ['frontend', 'backend'].some(surface => report[surface]?.timing_schema !== 2)) {
      throw new Error('Batch combination requires short dual-timing reports')
    }
    buildCanonicalComparison(report.frontend, report.backend)
    for (const surface of ['frontend', 'backend']) {
      for (const key of metadata) {
        if (JSON.stringify(report[surface][key]) !== JSON.stringify(batches[0].report[surface][key])) {
          throw new Error(`Batch configuration differs: ${surface}.${key}`)
        }
      }
    }
  }
  const report = { kind: 'voice-surface-compare', suite: 'short', created_at: new Date().toISOString(),
    batch_sources: batches.map(({ source, report: batch }) => ({ source, created_at: batch.created_at,
      case_ids: batch.frontend.results.map(result => result.id), recovery: batch.recovery || null })) }
  for (const surface of ['frontend', 'backend']) {
    const first = batches[0].report[surface]
    const results = batches.flatMap(({ report: batch }, index) => batch[surface].results
      .map(result => ({ ...result, batch_index: index })))
    report[surface] = { ...Object.fromEntries(metadata.map(key => [key, first[key]])), surface, results,
      case_count: results.length, turn_count: results.reduce((n, result) => n + result.turns.length, 0),
      error_count: results.filter(result => result.error).length,
      official_summary: summarizeScores(results.map(result => result.score)),
      batch_preflights: batches.map(({ report: batch }) => batch[surface].preflight || null) }
  }
  for (const key of ['input', 'zero_point', 'realtime_model', 'agent_model']) report[key] = report.frontend[key]
  // A case must not repeat across batches: two measurements of the same case
  // cannot be passed off as independent responses.
  report.comparison = buildCanonicalComparison(report.frontend, report.backend)
  return report
}

export async function combineReportFiles(sourcePaths, outPath) {
  const absolute = resolve(String(outPath))
  const sources = sourcePaths.map(source => resolve(String(source)))
  if (sources.includes(absolute)) throw new Error('Batch combination requires a new output path')
  const batches = await Promise.all(sources.map(async source => ({ source,
    report: JSON.parse(await readFile(source, 'utf8')) })))
  const report = combineReports(batches)
  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(absolute, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
  await writeCanonicalTables(report, absolute)
  console.table(report.comparison.groups)
  console.log(`\nreport: ${absolute}`)
  return report
}

// Published data uses a field whitelist: events, transcripts, tool payloads,
// credentials and local paths are never copied.
export function buildTimingReport(previous) {
  if (previous.suite !== 'short' || ['frontend', 'backend'].some(surface => previous[surface]?.timing_schema !== 2)) {
    throw new Error('Timing-only export requires short dual-timing measurements')
  }
  buildCanonicalComparison(previous.frontend, previous.backend)
  const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]))
  const recovery = value => value ? {
    source: basename(value.source || 'recovery'),
    ...pick(value, ['frontend_ids', 'backend_ids']),
  } : null
  const projectCase = result => ({
    ...pick(result, ['id', 'domain', 'batch_index']),
    user_turns: result.user_turns.map(turn => pick(turn, ['user', 'expect_no_tool'])),
    expected_calls: result.expected_calls.map(call => pick(call, ['name', 'turn_index'])),
    turns: result.turns.map(turn => ({
      ...pick(turn, ['turn_index', 'timed_out']),
      executed_calls: (turn.executed_calls || []).map(call => pick(call, ['name', 'started_ms', 'ended_ms', 'duration_ms'])),
    })),
    ...(result.previous_attempt ? { previous_attempt: projectCase(result.previous_attempt) } : {}),
  })
  const report = { kind: 'voice-surface-timing', suite: 'short',
    ...pick(previous, ['created_at', 'realtime_model', 'agent_model', 'zero_point']),
    input: pick(previous.input, ['engine', 'voice', 'sample_rate']),
    ...(previous.recovery ? { recovery: recovery(previous.recovery) } : {}),
    ...(previous.batch_sources ? { batch_sources: previous.batch_sources.map(batch => ({
      source: basename(batch.source), ...pick(batch, ['created_at', 'case_ids']), recovery: recovery(batch.recovery),
    })) } : {}),
  }
  for (const surface of ['frontend', 'backend']) {
    const raw = previous[surface]
    report[surface] = {
      ...pick(raw, ['suite', 'timing_schema', 'service_mode', 'realtime_model', 'agent_model', 'zero_point', 'session_policy']),
      surface, input: pick(raw.input, ['engine', 'voice', 'sample_rate']),
      parameters: pick(raw.parameters, ['silence_ms', 'timeout_ms', 'settle_ms']),
      routing: pick(raw.routing, COMPARED_DOMAINS), results: raw.results.map(projectCase),
    }
  }
  const c = buildCanonicalComparison(report.frontend, report.backend)
  const rowKeys = ['id', 'domain', 'turn_index', 'task', 'frontend_before_ms', 'backend_before_ms',
    'frontend_after_ms', 'backend_after_ms', 'before_difference_ms', 'after_difference_ms']
  report.comparison = {
    ...pick(c, ['timing_schema', 'service_mode', 'unit', 'metric', 'mean_policy', 'before_definition', 'after_definition']),
    tasks: c.tasks.map(row => pick(row, rowKeys)),
    chitchat: c.chitchat.map(row => pick(row, rowKeys)),
    no_tool_controls: c.no_tool_controls.map(row => pick(row, rowKeys)),
    groups: c.groups.map(group => Object.fromEntries(Object.entries(group).filter(([key]) => !key.includes('failure')))),
  }
  return report
}

export async function reanalyzeReport(sourcePath, outPath, { timingOnly = false } = {}) {
  const source = resolve(String(sourcePath))
  const absolute = resolve(String(outPath))
  if (source === absolute) throw new Error('Offline analysis requires a new output path')
  const previous = JSON.parse(await readFile(source, 'utf8'))
  if (previous.suite !== 'short' || !previous.frontend?.results || !previous.backend?.results) {
    throw new Error('Offline analysis requires a complete short comparison report')
  }
  const comparison = buildCanonicalComparison(previous.frontend, previous.backend)
  const report = timingOnly ? buildTimingReport(previous) : { ...previous, comparison,
    reanalysis: { source, created_at: new Date().toISOString(),
      note: 'offline recomputation; raw measurements, case scores and recovery attempts unchanged; comparison uses per-turn tool execution only' } }
  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(absolute, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
  await writeCanonicalTables(report, absolute)
  console.table(report.comparison.groups)
  console.log(`${comparison.tasks.length} task turns; ${comparison.chitchat.length} chitchat turns; ${comparison.no_tool_controls.length} clarification/refusal turns`)
  console.log(`\nreport: ${absolute}`)
  return report
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.has('from-reports')) {
    if (typeof args.get('from-reports') !== 'string' || typeof args.get('out') !== 'string'
      || [...args.keys()].some(key => !['from-reports', 'out'].includes(key))) {
      throw new Error('Batch combination accepts only --from-reports <source1,source2> --out <new report>')
    }
    await combineReportFiles(args.get('from-reports').split(','), args.get('out'))
    return
  }
  if (args.has('from-report')) {
    if (typeof args.get('from-report') !== 'string' || typeof args.get('out') !== 'string'
      || (args.has('timing-only') && args.get('timing-only') !== true)
      || [...args.keys()].some(key => !['from-report', 'out', 'timing-only'].includes(key))) {
      throw new Error('Offline analysis accepts --from-report <source> --out <new report> [--timing-only]')
    }
    await reanalyzeReport(args.get('from-report'), args.get('out'), { timingOnly: args.has('timing-only') })
    return
  }
  if (args.has('timing-only')) throw new Error('--timing-only requires --from-report and --out')
  loadCockpitEnvironment()
  if (!process.env.DASHSCOPE_API_KEY) {
    console.error('DASHSCOPE_API_KEY is required')
    process.exitCode = 1
    return
  }
  // Pin the models so the report states what actually ran instead of leaving it blank.
  process.env.QWEN_AUDIO_REALTIME_MODEL ||= 'qwen-audio-3.0-realtime-plus'
  process.env.DASHSCOPE_MODEL ||= 'qwen3.8-flash'

  const suite = String(args.get('suite') || 'short')
  const serviceMode = String(args.get('service-mode') || (suite === 'short' ? 'example' : 'controlled'))
  if (!['example', 'controlled'].includes(serviceMode)) throw new Error(`Unknown service mode: ${serviceMode}`)
  if (suite !== 'short' && serviceMode !== 'controlled') throw new Error('Real services require the short suite')
  const outPath = args.get('out')
    || `examples/smart-cockpit/bench/reports/voice-surface-${suite}-${serviceMode}-dual-${Date.now()}.json`
  const absolute = resolve(String(outPath))
  const recoveryPath = args.get('retry-errors-from')
  const previous = recoveryPath ? JSON.parse(await readFile(resolve(String(recoveryPath)), 'utf8')) : null
  if (previous && (suite !== 'short' || previous.suite !== 'short'
    || resolve(String(recoveryPath)) === absolute)) {
    throw new Error('Recovery requires short suite and a new output path')
  }
  if (previous && ['frontend', 'backend'].some(surface => previous[surface]?.timing_schema !== 2
    || previous[surface]?.service_mode !== serviceMode)) {
    throw new Error('Recovery requires matching dual timing schema and business service mode; old mock data cannot be reused')
  }
  if (previous && ['domain', 'limit', 'case-id'].some(key => args.has(key))) {
    throw new Error('Recovery selects errors automatically; do not pass domain, limit or case-id')
  }
  const selectedCases = previous
    ? ['frontend', 'backend'].flatMap(surface => previous[surface].results.filter(result => result.error))
    : loadCases({ suite, domain: args.get('domain'), limit: Number(args.get('limit') || 0), caseId: args.get('case-id') })
  assertVoiceCredentials(selectedCases, serviceMode)
  await mkdir(dirname(absolute), { recursive: true })
  const runId = new Date().toISOString().replaceAll(':', '-')
  const passthrough = ['--suite', suite, '--service-mode', serviceMode]
  for (const key of ['domain', 'limit', 'case-id', 'per-session', 'silence-ms', 'timeout-ms', 'settle-ms', 'say-voice', 'voice', 'agent-model']) {
    if (args.has(key)) passthrough.push(`--${key}`, String(args.get(key)))
  }

  async function runSurface(surface) {
    const old = previous?.[surface]
    const selected = old?.results.filter(result => result.error).map(result => result.id)
    if (old && !selected.length) return old
    const options = old ? [...passthrough, '--case-id', selected.join(',')] : passthrough
    const measured = await runWorker(surface, [...options, '--checkpoint', `${absolute}.${runId}.${surface}.jsonl`])
    return old ? mergeRecovery(old, measured) : measured
  }
  process.stderr.write('━━━ surface 1/2: frontend (realtime-api executes directly) ━━━\n')
  const frontend = await runSurface('frontend')
  await writeFile(`${absolute}.frontend.json`, `${JSON.stringify(frontend, null, 2)}\n`)
  process.stderr.write('\n━━━ surface 2/2: backend (spawn_thinking → A2A Agent) ━━━\n')
  const backend = await runSurface('backend')
  await writeFile(`${absolute}.backend.json`, `${JSON.stringify(backend, null, 2)}\n`)

  if (suite !== 'short') printComparison(frontend, backend)

  const report = {
    kind: 'voice-surface-compare',
    created_at: new Date().toISOString(),
    zero_point: frontend.zero_point,
    input: frontend.input,
    realtime_model: frontend.realtime_model,
    agent_model: frontend.agent_model,
    frontend,
    backend,
  }
  report.suite = suite
  if (previous) report.recovery = { source: resolve(String(recoveryPath)),
    frontend_ids: previous.frontend.results.filter(result => result.error).map(result => result.id),
    backend_ids: previous.backend.results.filter(result => result.error).map(result => result.id),
    policy: 'one retry of errors/timeouts only; original attempts preserved, no retries for ordinary scoring failures' }
  if (suite === 'short') {
    report.comparison = buildCanonicalComparison(frontend, backend)
    console.table(report.comparison.groups)
    console.log(`${report.comparison.tasks.length} per-turn tool responses; chitchat is listed separately and excluded from the latency means`)
    await writeCanonicalTables(report, absolute)
  }
  await writeFile(absolute, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`\nreport: ${absolute}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error?.stack || error)
    process.exitCode = 1
  })
}
