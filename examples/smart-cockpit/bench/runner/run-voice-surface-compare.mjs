#!/usr/bin/env node
// 音频输入下的前后端时延对比：同一批语音指令，分别让
//   frontend —— realtime-api 直接调用座舱工具
//   backend  —— realtime-api 经 spawn_thinking 委派给 A2A Agent 执行
// 两次运行使用同一套用例、同一音频仿真器（macOS say + ffmpeg）、同一零点（说完话）。
//
// 用法：
//   export DASHSCOPE_API_KEY=...
//   node run-voice-surface-compare.mjs                       # 全部 46 条用例
//   node run-voice-surface-compare.mjs --domain vehicle       # 仅车控
//   node run-voice-surface-compare.mjs --limit 8 --per-session 4
//
// 注意：两个表面**串行**执行，不并行。并行会让两条链路争抢同一个 realtime
// 配额与本机 CPU，测出来的差值就不再是架构差异而是资源竞争。
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
  // 领域整体翻转：表面路由按领域生效，要让车控/音乐/导航走后台必须整域改。
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
  const domains = { all: '合计', vehicle: '车控', navigation: '导航', music: '音乐', weather: '天气' }
  const taskHeaders = ['ID', '领域', '轮次', '指令', '前端工具响应/秒', '后端工具响应/秒', '前端实际工具', '后端实际工具', '观测异常']
  const taskRows = comparison.tasks.map(row => [row.id, domains[row.domain] || row.domain, `第 ${row.turn_index + 1} 轮`, row.task,
    seconds(row.frontend_ms), seconds(row.backend_ms), row.frontend_tools.join(', '), row.backend_tools.join(', '),
    [row.frontend_error && `前端：${row.frontend_error}`, row.backend_error && `后端：${row.backend_error}`].filter(Boolean).join('；')])
  const controlHeaders = ['ID/轮次', '话术', '前端座舱工具', '后端座舱工具', '前端网关工具', '后端网关工具']
  const controlRows = rows => rows.map(row => [`${row.id}/T${row.turn_index + 1}`, row.user,
    row.frontend_tools.join(', '), row.backend_tools.join(', '),
    row.frontend_gateway_tools.join(', '), row.backend_gateway_tools.join(', ')])
  const summary = comparison.groups.map(g => [domains[g.domain] || g.domain, g.total,
    g.frontend_count, g.backend_count, seconds(g.frontend_mean_ms), seconds(g.backend_mean_ms)])
  const html = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Short 逐轮工具响应时延</title>'
    + '<style>body{font:15px system-ui;margin:32px;color:#18212f}table{border-collapse:collapse;margin:20px 0;width:100%}td,th{border:1px solid #ddd;padding:8px;text-align:left}th{background:#edf2f7}tr:nth-child(even){background:#fafafa}td:first-child{font:12px monospace}</style>'
    + '<h1>仓库自带 short：逐轮座舱工具响应时延</h1>'
    + '<p>每轮独立计时：本轮最后一次座舱工具执行时间 − 本轮语音 PCM 推送完的时间。不取 audio.done、后台任务终态或确认窗口时间。同一 case 的多轮共享原上下文，但每个任务轮单独一行、独立计入均值，不再累计成 case 耗时；首轮冷启保留。</p>'
    + '<p>只统计时间，不按工具调用正确性或 case 评分筛选。前后端分别对各自所有可计时响应取算术平均值，未要求另一端也有时间戳；可计时样本可能不同，分别列出数量，保留真实长尾。领域按原任务所属领域归类，不随实际调用的工具改变。</p>'
    + '<p>工具误调用、参数错误和重复调用均保留实际工具执行时延；未调用或缺失工具时间戳记为 —，不当作零时延，也不回退到音频结束时间。观测异常保留；已有工具时间戳不因等待音频超时而消失。</p>'
    + '<p>闲聊与澄清/拒绝单列原始调用记录，不计入任务时延均值。原始评分仍保存在 JSON 中，不在本时延表展示，也不参与时间筛选。</p>'
    + (report.reanalysis ? `<p>离线重算来源：${esc(report.reanalysis.source)}。复用原始音频实测时间戳，未重新调用模型；原始报告不变。</p>` : '')
    + (report.recovery ? `<p>来源含连接/超时补测：${esc(report.recovery.frontend_ids.join(', ')) || '无'}（前端）；${esc(report.recovery.backend_ids.join(', ')) || '无'}（后端）。原始尝试保留，未重试普通评分失败。</p>` : '')
    + '<h2>每次响应的平均工具时延</h2>' + table(['领域', '任务轮数', '前端可计时数', '后端可计时数', '前端均值/秒', '后端均值/秒'], summary)
    + '<h2>逐轮响应</h2>' + table(taskHeaders, taskRows)
    + '<h2>闲聊（应由前端直接回答）</h2>' + table(controlHeaders, controlRows(comparison.chitchat))
    + '<h2>澄清/拒绝：不应执行工具</h2>' + table(controlHeaders, controlRows(comparison.no_tool_controls)) + '</html>'
  const csv = rows => '\ufeff' + rows.map(row => row.map(value => `"${String(value ?? '').replaceAll('"', '""')}"`).join(',')).join('\n') + '\n'
  await writeFile(`${absolute}.html`, html)
  await writeFile(`${absolute}.tasks.csv`, csv([taskHeaders, ...taskRows]))
  await writeFile(`${absolute}.chitchat.csv`, csv([controlHeaders, ...controlRows(comparison.chitchat)]))
  await writeFile(`${absolute}.no-tool.csv`, csv([controlHeaders, ...controlRows(comparison.no_tool_controls)]))
}

async function writeDualTables(report, absolute) {
  const c = report.comparison
  const domains = { all: '合计', vehicle: '车控', navigation: '导航', music: '音乐', weather: '天气' }
  const seconds = ms => Number.isFinite(ms) ? (ms / 1000).toFixed(3) : '—'
  const esc = value => String(value ?? '').replace(/[&<>"']/gu,
    char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
  const table = (heads, rows) => '<table><thead><tr>' + heads.map(h => `<th>${esc(h)}</th>`).join('')
    + '</tr></thead><tbody>' + rows.map(row => '<tr>' + row.map(v => `<td>${esc(v)}</td>`).join('') + '</tr>').join('') + '</tbody></table>'
  const csv = (heads, rows) => '\ufeff' + [heads, ...rows].map(row => row
    .map(value => `"${String(value ?? '').replaceAll('"', '""')}"`).join(',')).join('\n') + '\n'
  const phases = [['before', '执行前'], ['after', '执行后']].map(([key, label]) => ({
    key, label,
    summaryHeads: ['领域', '任务轮数', `前端${label}/秒`, `后端${label}/秒`, '差值（后−前）/秒', '前端有效数', '后端有效数'],
    summaryRows: c.groups.map(g => [domains[g.domain] || g.domain, g.total,
      seconds(g[`frontend_${key}_mean_ms`]), seconds(g[`backend_${key}_mean_ms`]), seconds(g[`${key}_difference_ms`]),
      g[`frontend_${key}_count`], g[`backend_${key}_count`]]),
    taskHeads: ['ID', '领域', '轮次', '指令', `前端${label}/秒`, `后端${label}/秒`, '差值（后−前）/秒'],
    taskRows: c.tasks.map(r => [r.id, domains[r.domain] || r.domain, `第 ${r.turn_index + 1} 轮`, r.task,
      seconds(r[`frontend_${key}_ms`]), seconds(r[`backend_${key}_ms`]), seconds(r[`${key}_difference_ms`])]),
  }))
  const markdownTable = (heads, rows) => [heads, heads.map(() => '---'), ...rows]
    .map(row => '| ' + row.map(value => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ')).join(' | ') + ' |').join('\n')
  const source = c.service_mode === 'example'
    ? '与 example 正常运行一致：导航地点与天气使用真实高德 MCP，驾车路线使用真实高德 REST；音乐与车控沿用 example 本地实现。未注入固定路线或预置天气。'
    : '本报告使用 controlled 模拟业务数据，不代表真实高德服务。'
  const notes = [source,
    `实时模型：${report.realtime_model}；后台模型：${report.agent_model}。`,
    '单位：秒。执行前 = 语音 PCM 推送结束到本轮最晚一次 service.execute 开始；执行后 = 同一零点到全部已调用工具结束后的最晚 resolve/reject。不含之后的 MCP 返回传输、应答音频或后台任务终态，也不代表实车动作完成。',
    '多轮独立计入，首轮冷启保留；一轮多个工具取最晚开始和最晚结束，不累加，两个终点可能属于不同并发工具。两端各自取有时间戳响应的算术平均，不筛选工具匹配或执行结果；差值为后端减前端。',
    '未调用工具或缺时间戳为 —，不按零计算；失败返回仍计时，执行后不等同于业务成功。两端样本可能不同，请同时查看有效数，尤其注意小样本领域。',
    `任务 ${c.tasks.length} 轮；闲聊 ${c.chitchat.length} 轮、澄清/拒绝 ${c.no_tool_controls.length} 轮保留在评测数据中，不计任务均值。不展示评分、转写、工具返回或过程日志。`,
  ]
  if (report.recovery) notes.push('本报告含连接/超时补测，原始计时尝试保留在数据中。')
  if (report.batch_sources) {
    notes.push('分批来源：这是分领域、分时段实测的离线汇总，不是同一次连续运行；均值按响应重算，不平均批次均值。')
    for (const batch of report.batch_sources) notes.push(`${basename(batch.source)}；${batch.created_at}；${batch.case_ids.length} 条用例；${batch.recovery ? '含补测' : '未补测'}。`)
  }
  const stem = basename(absolute)
  const html = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Short 前后端工具时延</title>'
    + '<style>body{font:15px system-ui;margin:32px;color:#18212f}table{border-collapse:collapse;margin:20px 0;width:100%}th,td{border:1px solid #ddd;padding:8px;text-align:left}th{background:#edf2f7}</style>'
    + '<h1>Short 前后端工具时延</h1>' + notes.map(note => `<p>${esc(note)}</p>`).join('')
    + phases.map(p => `<h2>${p.label}</h2>` + table(p.summaryHeads, p.summaryRows)
      + `<p><a href="${esc(encodeURIComponent(`${stem}.${p.key}.csv`))}">${p.label}逐轮数据 CSV</a></p>`).join('') + '</html>\n'
  const markdown = '# Short 前后端工具时延\n\n' + notes.join('\n\n') + '\n\n'
    + phases.map(p => `## ${p.label}\n\n${markdownTable(p.summaryHeads, p.summaryRows)}\n\n`
      + `[${p.label}逐轮数据 CSV](${encodeURIComponent(`${stem}.${p.key}.csv`)})`).join('\n\n') + '\n'
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
  console.log('│  音频输入下的前后端时延对比（零点 = 说完话）'.padEnd(72) + '│')
  console.log(`├${line}┤`)
  console.log(`│  输入: ${frontend.input.engine} / ${frontend.input.voice} / ${frontend.input.sample_rate}Hz`.padEnd(79) + '│')
  console.log(`│  realtime: ${frontend.realtime_model || 'default'}   agent: ${frontend.agent_model || 'default'}`.padEnd(79) + '│')
  console.log(`└${line}┘`)

  const rows = [
    ['说完话 → ASR 终稿', 'user_transcript_ms'],
    ['说完话 → 首帧回应音频', 'first_audio_ms'],
    ['说完话 → 座舱动作执行', 'cockpit_tool_ms'],
    ['说完话 → 本轮彻底结束', 'turn_settled_ms'],
    ['↑ 仅成功用例', 'turn_settled_ms_success_only'],
    ['说完话 → 后台任务完成', 'task_completed_ms'],
  ]

  console.log('\n热轮（已排除每会话首句的 VAD/ASR 预热）:')
  console.log('┌────────────────────────────────┬────────────┬────────────┬────────────┐')
  console.log('│ 指标                           │  Frontend  │  Backend   │     Δ      │')
  console.log('├────────────────────────────────┼────────────┼────────────┼────────────┤')
  for (const [label, key] of rows) {
    const a = frontend.hot[key]?.median_ms
    const b = backend.hot[key]?.median_ms
    const delta = a != null && b != null ? b - a : null
    const sign = delta != null && delta >= 0 ? '+' : ''
    console.log(
      `│ ${label.padEnd(30 - (label.length - [...label].length))} │ ${fmt(a).padStart(10)} │ ${fmt(b).padStart(10)} │ `
      + `${(delta == null ? '—' : sign + fmt(delta)).padStart(10)} │`,
    )
  }
  console.log('└────────────────────────────────┴────────────┴────────────┴────────────┘')

  const toolA = frontend.hot.cockpit_tool_ms?.median_ms
  const toolB = backend.hot.cockpit_tool_ms?.median_ms
  if (toolA && toolB) {
    console.log(`\n  座舱动作时延比: ${(toolB / toolA).toFixed(2)}x（后台 / 前台）`)
  }
  const settleA = frontend.hot.turn_settled_ms?.median_ms
  const settleB = backend.hot.turn_settled_ms?.median_ms
  if (settleA && settleB) {
    console.log(`  本轮结束时延比: ${(settleB / settleA).toFixed(2)}x（后台 / 前台）`)
  }

  console.log('\n准确率（热轮）:')
  console.log('┌────────────┬────────┬────────────┬────────────┬────────────┬────────────┐')
  console.log('│ Surface    │  样本  │  工具名对  │  参数对    │ 终态对(写) │ 任务达成   │')
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
  console.log('  任务达成 = 调对工具 且 终态与金标一致。金标由用例声明的 explicit_calls')
  console.log('  打在干净 service 上构造而来，不是人工标注的期望态。')
  console.log('  终态对(写) 只统计写操作用例：只读工具改不动状态，算进去会虚高。')

  console.log('\n执行可靠性:')
  console.log('┌────────────┬────────────┬────────────┬────────────┬────────────┐')
  console.log('│ Surface    │  用例数    │  已执行    │  未触发    │  已委派    │')
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

  console.log('\n冷启对比（每会话首句，含 VAD/ASR 预热）:')
  for (const report of [frontend, backend]) {
    console.log(
      `  ${report.surface.padEnd(9)} 动作=${fmt(report.cold.cockpit_tool_ms?.median_ms)}`
      + `  首音频=${fmt(report.cold.first_audio_ms?.median_ms)}`,
    )
  }

  console.log('\n  注: backend 的"首帧回应"通常比 frontend 更早——它先播"好的，正在处理"的')
  console.log('  占位应答再去执行；但"动作真正发生"要等 A2A Agent 完成一次独立推理，')
  console.log('  所以听感上快、实际上慢。判断放前台还是后台应看座舱动作时延。')
}

// 分领域分批实测的离线汇总：保留来源，不混合旧埋点或不同运行配置。
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
  // 同一 case 不得跨批次重复，不能把两次实测悄悄当成独立响应。
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

// 发布数据采用字段白名单；不复制事件、转写、返回内容、凭据或本机路径。
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
  console.log(`任务响应 ${comparison.tasks.length} 轮；闲聊 ${comparison.chitchat.length} 轮；澄清/拒绝 ${comparison.no_tool_controls.length} 轮`)
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
  // 让报告自描述实际使用的模型，而不是留空。
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
  process.stderr.write('━━━ 表面 1/2: frontend (realtime-api 直接执行) ━━━\n')
  const frontend = await runSurface('frontend')
  await writeFile(`${absolute}.frontend.json`, `${JSON.stringify(frontend, null, 2)}\n`)
  process.stderr.write('\n━━━ 表面 2/2: backend (spawn_thinking → A2A Agent) ━━━\n')
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
    console.log(`逐轮工具响应 ${report.comparison.tasks.length} 条；闲聊单列，不计工具时延均值`)
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
