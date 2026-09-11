import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  COCKPIT_TOOL_NAMES,
  COCKPIT_TOOL_DEFINITIONS,
} from '../../service/tools/registry.mjs'

import { loadCases, classifyTurn, scoreCanonicalResult, createVoiceService,
  observeToolExecution, measuredToolCalls, toolTiming, verifyLiveService, hasUnfinishedWork,
  liveDomainsFor, assertVoiceCredentials } from '../runner/voice-surface-worker.mjs'
import { buildCanonicalComparison, mergeRecovery, reanalyzeReport, writeCanonicalTables,
  combineReports, combineReportFiles, buildTimingReport } from '../runner/run-voice-surface-compare.mjs'
import { startCockpitServiceServer } from '../../service/server.mjs'
import { loadBenchmarkCases, routeCasesExpectedPaths } from '../evaluator/cases.mjs'
import { createBenchmarkService } from '../runner/controlled-harness.mjs'

const execFileAsync = promisify(execFile)
const CASES_URL = new URL('../cases/surface-compare.jsonl', import.meta.url)
const WORKER_PATH = fileURLToPath(new URL('../runner/surface-latency-worker.mjs', import.meta.url))

// 前后端对比用例只覆盖这些领域；flashbuy 与 custom-skills 依赖多轮确认，
// 不属于"同一原子指令换表面执行"的对比范围。
const COMPARED_DOMAINS = Object.freeze(['vehicle', 'music', 'navigation', 'weather'])

function loadSurfaceCompareCases() {
  return readFileSync(CASES_URL, 'utf8')
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line))
}

const cases = loadSurfaceCompareCases()
const toolNames = new Set(COCKPIT_TOOL_NAMES)

test('surface-compare cases are well formed', () => {
  assert.ok(cases.length > 0, 'expected at least one surface-compare case')
  const seen = new Set()
  for (const caseItem of cases) {
    assert.equal(typeof caseItem.id, 'string', 'case id must be a string')
    assert.ok(!seen.has(caseItem.id), `duplicate case id: ${caseItem.id}`)
    seen.add(caseItem.id)
    assert.ok(
      COMPARED_DOMAINS.includes(caseItem.domain),
      `case ${caseItem.id} has unexpected domain ${caseItem.domain}`,
    )
    assert.ok(
      Array.isArray(caseItem.turns) && typeof caseItem.turns[0]?.user === 'string',
      `case ${caseItem.id} must declare a first user turn`,
    )
    assert.ok(
      Array.isArray(caseItem.explicit_calls) && caseItem.explicit_calls.length > 0,
      `case ${caseItem.id} must declare explicit_calls`,
    )
    for (const call of caseItem.explicit_calls) {
      assert.ok(toolNames.has(call.name), `case ${caseItem.id} calls unknown tool ${call.name}`)
      assert.equal(
        typeof call.arguments,
        'object',
        `case ${caseItem.id} call ${call.name} must declare arguments`,
      )
    }
  }
})

test('surface-compare cases cover every tool in the compared domains', () => {
  // 新增车控/音乐/导航工具时必须同步补用例，否则对比结果会漏掉该能力。
  const expected = COCKPIT_TOOL_DEFINITIONS
    .map(tool => tool.name)
    .filter(name => (
      name === 'weather'
      || COMPARED_DOMAINS.some(domain => name.startsWith(`${domain}_`))
    ))
  const covered = new Set(cases.flatMap(
    caseItem => caseItem.explicit_calls.map(call => call.name),
  ))
  const missing = expected.filter(name => !covered.has(name))
  assert.deepEqual(missing, [], `surface-compare cases miss tools: ${missing.join(', ')}`)
})

// 两条链路各跑一次最小用例，确认测量 harness 端到端可用：
// frontend 走 MCP/HTTP，backend 走 A2A -> Agent -> MCP/HTTP，模型为零耗时 stub。
async function runWorker(surface) {
  const domains = Object.fromEntries(COMPARED_DOMAINS.map(domain => [domain, surface]))
  const { stdout } = await execFileAsync(
    process.execPath,
    [WORKER_PATH, '--surface', surface, '--domain', 'weather', '--repeats', '1', '--warmup', '0'],
    { env: { ...process.env, COCKPIT_DOMAIN_SURFACES: JSON.stringify({ domains }) } },
  )
  return JSON.parse(stdout.trim().split(/\r?\n/u).at(-1))
}

test('both surfaces execute the same case through their real transport', async () => {
  const [frontend, backend] = await Promise.all([
    runWorker('frontend'),
    runWorker('backend'),
  ])

  for (const report of [frontend, backend]) {
    assert.deepEqual(report.skipped, [], `${report.surface} skipped cases: ${JSON.stringify(report.skipped)}`)
    assert.equal(report.case_count, 1, `${report.surface} should measure exactly one case`)
    const [result] = report.results
    assert.equal(result.tool, 'weather')
    assert.equal(result.routed_surface, report.surface)
    assert.ok(
      Number.isFinite(result.median_ms) && result.median_ms > 0,
      `${report.surface} median must be a positive number, got ${result.median_ms}`,
    )
  }

  assert.match(frontend.path, /mcp\/frontend/u)
  assert.match(backend.path, /A2A/u)
})

test('short loader preserves all canonical turns and separates chitchat from negative controls', () => {
  const short = loadCases()
  assert.equal(short.length, 86)
  const original = loadBenchmarkCases({ suite: 'short' })
  for (const [index, item] of short.entries()) {
    assert.equal(item.id, original[index].id)
    assert.deepEqual(item.turns, original[index].turns)
    assert.deepEqual(item.expected_final_state, original[index].expected_final_state)
  }
  const kinds = short.flatMap(item => item.turns.map((_, index) => classifyTurn(item, index)))
  assert.equal(kinds.length, 111)
  assert.equal(kinds.filter(kind => kind === 'chitchat').length, 14)
  assert.equal(kinds.filter(kind => kind === 'no_tool_control').length, 5)
  assert.equal(kinds.filter(kind => kind === 'task').length, 92)
  assert.equal(loadCases({ caseId: 'nav_context_view_follow_021' })[0].turns.length, 3)
  assert.throws(() => loadCases({ suite: 'long' }), /Unsupported suite/u)
})

test('both routes pass canonical gold replay using the original evaluator', async () => {
  for (const surface of ['frontend', 'backend']) {
    const service = createBenchmarkService()
    const items = routeCasesExpectedPaths(loadBenchmarkCases({ suite: 'short' }), {
      surfaceForTool: () => surface,
    })
    for (const item of items) {
      const cockpitId = item.id
      service.reset(cockpitId)
      for (const call of item.setup_calls || []) await service.execute(call.name, call.arguments, { cockpitId })
      const trace = { calls: [], state_snapshots: [] }
      const turns = []
      for (const [index] of item.turns.entries()) {
        for (const call of item.expected_calls.filter(call => call.turn_index === index)) {
          await service.execute(call.name, call.arguments, { cockpitId })
          trace.calls.push(call)
        }
        trace.state_snapshots.push({ turn_index: index, state: service.snapshot(cockpitId) })
        turns.push({ turn_index: index, kind: classifyTurn(item, index), turn_settled_ms: 1000 })
      }
      trace.final_state = service.snapshot(cockpitId)
      const result = scoreCanonicalResult(item, trace, turns)
      assert.ok(result.task_success, `${surface}/${item.id}: ${JSON.stringify(result.score)}`)
      const taskTurns = turns.filter(turn => turn.kind === 'task').length
      assert.equal(result.successful_task_wait_ms, taskTurns ? taskTurns * 1000 : null)
      const timedOut = scoreCanonicalResult(item, trace, [{ ...turns[0], timed_out: true }, ...turns.slice(1)])
      assert.equal(timedOut.task_success, false)
      assert.equal(timedOut.successful_task_wait_ms, null)
    }
  }
})

function toolReport(surface, caseId) {
  const items = routeCasesExpectedPaths(loadCases({ caseId }), { surfaceForTool: () => surface })
  return { official_summary: { total_cases: items.length, pass_rate: 1 }, results: items.map(item => ({
    id: item.id, domain: item.domain, user_turns: item.turns, expected_calls: item.expected_calls,
    score: { passed: true }, task_success: true,
    turns: item.turns.map((_, index) => ({ turn_index: index, kind: classifyTurn(item, index),
      executed_calls: item.expected_calls.filter(call => call.turn_index === index)
        .map(call => ({ ...call, completed_ms: (index + 1) * 1000 })),
      last_cockpit_tool_ms: (index + 1) * 1000, turn_settled_ms: 30000,
      task_completed_ms: 25000, no_tool_compliant: classifyTurn(item, index) !== 'task' })),
  })) }
}

test('逐轮统计保留全部 92 个响应，不累计多轮，也不引用音频结束时间', () => {
  const f = toolReport('frontend')
  const b = toolReport('backend')
  const before = structuredClone([f, b])
  const comparison = buildCanonicalComparison(f, b)
  assert.equal(comparison.metric, 'speech_end_to_last_cockpit_tool_execution')
  assert.equal(comparison.unit, 'task_turn')
  assert.equal(comparison.tasks.length, 92)
  assert.equal(comparison.chitchat.length, 14)
  assert.equal(comparison.no_tool_controls.length, 5)
  assert.equal(comparison.groups[0].frontend_count, 92)
  assert.equal(comparison.groups[0].backend_count, 92)
  assert.deepEqual(comparison.groups.map(g => [g.domain, g.total]),
    [['all', 92], ['vehicle', 23], ['music', 17], ['navigation', 44], ['weather', 8]])
  const view = comparison.tasks.filter(row => row.id === 'nav_context_view_follow_021')
  assert.deepEqual(view.map(row => row.turn_index), [0, 1, 2])
  assert.deepEqual(view.map(row => row.frontend_ms), [1000, 2000, 3000])
  assert.equal(comparison.chitchat_mean, undefined)
  assert.equal(comparison.chitchat[0].frontend_config_ms, undefined)
  assert.equal(comparison.case_accuracy, undefined)
  assert.equal(comparison.turn_match_definition, undefined)
  assert.ok(comparison.tasks.every(row => !('frontend_calls_match' in row) && !('backend_calls_match' in row)))
  assert.deepEqual([f, b], before)
})

test('各端独立平均并保留长尾，缺失不影响另一端，评分失败不筛掉工具时延', () => {
  const f = toolReport('frontend', 'nav_context_add_waypoint_014')
  const b = toolReport('backend', 'nav_context_add_waypoint_014')
  b.results[0].score.passed = false
  b.results[0].task_success = false
  b.results[0].turns[0].executed_calls[0].completed_ms = 60000
  b.results[0].turns[1].executed_calls = []
  const comparison = buildCanonicalComparison(f, b)
  assert.deepEqual(comparison.groups[0], { domain: 'all', total: 2,
    frontend_count: 2, backend_count: 1, frontend_mean_ms: 1500, backend_mean_ms: 60000 })
  assert.equal(comparison.tasks[0].backend_case_passed, undefined)
  assert.equal(comparison.tasks[0].backend_ms, 60000)
  assert.equal(comparison.tasks[1].backend_ms, null)
  assert.throws(() => buildCanonicalComparison(f, { results: [] }), /IDs differ/u)
})

test('一轮多次工具执行取最后时间，音频超时不改变已观测到的工具时延', () => {
  const f = toolReport('frontend', 'veh_single_climate_start_003')
  const b = toolReport('backend', 'veh_single_climate_start_003')
  for (const report of [f, b]) {
    const result = report.results[0]
    result.expected_calls.push({ ...result.expected_calls[0] })
    const turn = result.turns[0]
    turn.executed_calls = result.expected_calls.map((call, index) => ({ ...call, completed_ms: [900, 100][index] }))
    turn.last_cockpit_tool_ms = 100
    turn.turn_settled_ms = 59000
    turn.timed_out = true
    result.task_success = false
  }
  const comparison = buildCanonicalComparison(f, b)
  assert.equal(comparison.tasks.length, 1)
  assert.equal(comparison.tasks[0].frontend_ms, 900)
  assert.equal(comparison.tasks[0].frontend_error, 'observation timed out')
  assert.equal(comparison.groups[0].frontend_mean_ms, 900)
  assert.equal(comparison.groups[0].frontend_count, 1)
})

test('误调用、参数错误和重复调用均参与时间均值，领域保持原任务归属', () => {
  for (const actual of [
    [{ name: 'music_play', arguments: {}, completed_ms: 1234 }],
    [{ name: 'vehicle_climate_control', arguments: { unexpected: true }, completed_ms: 1234 }],
    [{ name: 'music_play', completed_ms: 500 }, { name: 'music_play', completed_ms: 1234 }],
  ]) {
    const f = toolReport('frontend', 'veh_single_climate_start_003')
    const b = toolReport('backend', 'veh_single_climate_start_003')
    b.results[0].turns[0].executed_calls = actual
    b.results[0].score.passed = false
    b.results[0].task_success = false
    const comparison = buildCanonicalComparison(f, b)
    assert.equal(comparison.tasks[0].backend_ms, 1234)
    assert.equal(comparison.groups[0].backend_count, 1)
    assert.equal(comparison.groups[0].backend_mean_ms, 1234)
    assert.equal(comparison.groups[0].frontend_mean_ms, 1000)
    assert.equal(comparison.groups[1].domain, 'vehicle')
    assert.equal(comparison.groups[1].backend_mean_ms, 1234)
  }
})

test('缺失时间不回退到音频时延，不影响另一端计时，真实零时延参与均值', () => {
  const f = toolReport('frontend', 'veh_single_climate_start_003')
  const b = toolReport('backend', 'veh_single_climate_start_003')
  b.results[0].turns[0].executed_calls = [{ ...b.results[0].expected_calls[0] }]
  b.results[0].turns[0].last_cockpit_tool_ms = null
  let comparison = buildCanonicalComparison(f, b)
  assert.equal(comparison.tasks[0].backend_ms, null)
  assert.equal(comparison.groups[0].backend_count, 0)
  assert.equal(comparison.groups[0].backend_mean_ms, null)
  assert.equal(comparison.groups[0].frontend_count, 1)
  assert.equal(comparison.groups[0].frontend_mean_ms, 1000)
  b.results[0].turns[0].last_cockpit_tool_ms = 0
  comparison = buildCanonicalComparison(f, b)
  assert.equal(comparison.tasks[0].backend_ms, 0)
  assert.equal(comparison.groups[0].backend_count, 1)
  assert.equal(comparison.groups[0].backend_mean_ms, 0)
})

test('拒绝不同轮次内容或重复 case 的不公平配对', () => {
  const f = toolReport('frontend', 'veh_single_climate_start_003')
  const b = toolReport('backend', 'veh_single_climate_start_003')
  b.results[0].user_turns = [{ user: '另一句指令' }]
  assert.throws(() => buildCanonicalComparison(f, b), /turns or gold calls differ/u)
  assert.throws(() => buildCanonicalComparison({ results: [f.results[0], f.results[0]] }, f), /duplicates/u)
})

function dualReport(surface, caseId) {
  const report = toolReport(surface, caseId)
  report.timing_schema = 2
  report.service_mode = 'example'
  for (const result of report.results) {
    for (const turn of result.turns) {
      turn.executed_calls = turn.executed_calls.map(({ completed_ms, ...call }) => ({ ...call,
        started_ms: completed_ms, ended_ms: completed_ms + 250, outcome: 'returned' }))
    }
  }
  return report
}

function batchFixtures() {
  return [['vehicle', 'music'], ['navigation', 'weather']].map((domains, index) => {
    const report = { suite: 'short', created_at: `batch-${index}` }
    for (const surface of ['frontend', 'backend']) {
      report[surface] = dualReport(surface)
      report[surface].results = report[surface].results.filter(result => domains.includes(result.domain))
      report[surface].parameters = { timeout_ms: 120000, settle_ms: 1200 }
      report[surface].realtime_model = 'test-realtime'
      report[surface].agent_model = 'test-agent'
    }
    return { source: `batch-${index}.json`, report }
  })
}

test('分批汇总保留来源和原始轮次，按响应重新计算均值而非平均各批均值', () => {
  const batches = batchFixtures()
  for (const result of batches[1].report.frontend.results) {
    for (const turn of result.turns) for (const call of turn.executed_calls) {
      call.started_ms = 10000
      call.ended_ms = 12000
    }
  }
  batches[1].report.backend.results[0].error = 'connection error'
  const before = structuredClone(batches)
  const report = combineReports(batches)
  const c = report.comparison
  assert.equal(report.frontend.case_count, 86)
  assert.equal(report.frontend.turn_count, 111)
  assert.equal(report.backend.error_count, 1)
  assert.deepEqual(report.batch_sources.map(batch => batch.case_ids.length), [42, 44])
  assert.deepEqual(report.batch_sources.map(batch => batch.created_at), ['batch-0', 'batch-1'])
  assert.equal(report.frontend.results.at(-1).batch_index, 1)
  assert.deepEqual([c.tasks.length, c.chitchat.length, c.no_tool_controls.length], [92, 14, 5])
  const expected = c.tasks.reduce((sum, row) => sum + row.frontend_before_ms, 0) / 92
  assert.equal(c.groups[0].frontend_before_mean_ms, Math.round(expected * 10) / 10)
  assert.deepEqual(batches, before)
})

test('分批汇总拒绝重复 case、旧 schema 和不一致的模型、参数、服务', () => {
  const batches = batchFixtures()
  assert.throws(() => combineReports([batches[0]]), /At least two/u)
  assert.throws(() => combineReports([batches[0], batches[0]]), /duplicates/u)
  for (const [key, value] of [['realtime_model', 'another'], ['agent_model', 'another'],
    ['parameters', { timeout_ms: 60000 }], ['service_mode', 'controlled'], ['timing_schema', 1]]) {
    const changed = structuredClone(batches)
    for (const surface of ['frontend', 'backend']) changed[1].report[surface][key] = value
    assert.throws(() => combineReports(changed), /configuration differs|dual-timing/u)
  }
})

test('分批汇总不允许覆盖任何来源文件', async () => {
  await assert.rejects(combineReportFiles(['/batch-a.json', '/batch-b.json'], '/batch-a.json'), /new output path/u)
})

test('双指标按原领域拆分全部任务轮，保持上下文且不修改输入', () => {
  const f = dualReport('frontend'); const b = dualReport('backend')
  const before = structuredClone([f, b])
  const c = buildCanonicalComparison(f, b)
  assert.equal(c.timing_schema, 2)
  assert.equal(c.service_mode, 'example')
  assert.equal(c.tasks.length, 92)
  assert.equal(c.chitchat.length, 14)
  assert.equal(c.no_tool_controls.length, 5)
  assert.deepEqual(c.groups.map(g => [g.domain, g.total]),
    [['all', 92], ['vehicle', 23], ['music', 17], ['navigation', 44], ['weather', 8]])
  assert.equal(c.groups[0].frontend_before_count, 92)
  assert.equal(c.groups[0].backend_after_count, 92)
  const rows = c.tasks.filter(r => r.id === 'nav_context_view_follow_021')
  assert.deepEqual(rows.map(r => r.frontend_before_ms), [1000, 2000, 3000])
  assert.deepEqual(rows.map(r => r.frontend_after_ms), [1250, 2250, 3250])
  assert.equal(c.case_accuracy, undefined)
  assert.deepEqual([f, b], before)
})

test('双指标独立计数，含误调用、失败返回、长尾和零时延，不回退音频或旧埋点', () => {
  const f = dualReport('frontend', 'nav_context_add_waypoint_014')
  const b = dualReport('backend', 'nav_context_add_waypoint_014')
  f.results[0].turns[1].executed_calls = [{ name: 'navigation_add_waypoint', started_ms: 0, ended_ms: null }]
  b.results[0].score.passed = false
  b.results[0].turns[0].timed_out = true
  b.results[0].turns[0].executed_calls = [{ name: 'music_play', started_ms: 60000, ended_ms: 62000,
    outcome: 'threw', error: 'service unavailable' }]
  b.results[0].turns[1].executed_calls = []
  const c = buildCanonicalComparison(f, b)
  const g = c.groups[0]
  assert.equal(g.frontend_before_count, 2)
  assert.equal(g.frontend_before_mean_ms, 500)
  assert.equal(g.frontend_after_count, 1)
  assert.equal(g.frontend_after_mean_ms, 1250)
  assert.equal(g.backend_before_mean_ms, 60000)
  assert.equal(g.backend_after_mean_ms, 62000)
  assert.equal(g.backend_after_count, 1)
  assert.equal(g.backend_failure_turn_count, 1)
  assert.equal(g.before_difference_ms, 59500)
  assert.equal(c.tasks[0].before_difference_ms, 59000)
  assert.equal(c.tasks[0].after_difference_ms, 60750)
  assert.equal(c.tasks[0].domain, 'navigation')
  assert.match(c.tasks[0].backend_error, /service unavailable/u)
  assert.equal(c.tasks[1].frontend_after_ms, null)
  assert.equal(c.tasks[1].backend_before_ms, null)
  assert.equal(c.tasks[1].after_difference_ms, null)
  assert.ok(!('frontend_calls_match' in c.tasks[0]))
  assert.deepEqual(toolTiming([{ completed_ms: 500 }]), { before_ms: null, after_ms: null })
})

test('并发调用分别取最晚开始和最晚结束，未结束的调用不能生成结束均值', () => {
  assert.deepEqual(toolTiming([
    { started_ms: 100, ended_ms: 900 }, { started_ms: 500, ended_ms: 600 },
  ]), { before_ms: 500, after_ms: 900 })
  assert.deepEqual(toolTiming([
    { started_ms: 100, ended_ms: 900 }, { started_ms: 500, ended_ms: null },
  ]), { before_ms: 500, after_ms: null })
  assert.deepEqual(toolTiming([]), { before_ms: null, after_ms: null })
})

test('异常后尚有后台任务或异步工具时必须停止后续采样，防止跨 case 污染', () => {
  const running = { type: 'task.running', task: { id: 'a' } }
  const done = { type: 'task.completed', task: { id: 'a' } }
  assert.equal(hasUnfinishedWork([running], []), true)
  assert.equal(hasUnfinishedWork([running, done], []), false)
  assert.equal(hasUnfinishedWork([running, done], [{ ended_at: null }]), true)
  assert.equal(hasUnfinishedWork([], [{ ended_at: 0 }]), false)
  assert.equal(hasUnfinishedWork([
    { type: 'task.delegated', task: { taskId: 'b' } },
    { type: 'task.failed', task: { taskId: 'b' } },
  ], []), false)
})

test('不允许把旧执行入口埋点或模拟业务报告与新真实服务合并', () => {
  const f = dualReport('frontend'); const b = dualReport('backend')
  assert.throws(() => buildCanonicalComparison(f, toolReport('backend')), /schemas or business service modes differ/u)
  assert.throws(() => buildCanonicalComparison(f, { ...b, service_mode: 'controlled' }), /schemas or business service modes differ/u)
  assert.throws(() => mergeRecovery(f, toolReport('frontend')), /schemas or business service modes differ/u)
})

test('观测包装等待实际异步返回、保持返回值和并发业务请求归属', async () => {
  let now = 100
  const pending = new Map()
  const output = { content: '已完成', data: { ok: true } }
  const service = {
    services: { weather: city => new Promise(resolve => pending.set(city, resolve)) },
    async execute(_name, args) { return this.services.weather(args.city) },
  }
  const log = []
  observeToolExecution(service, { surface: 'backend', toolLog: log, clock: () => now })
  const first = service.execute('weather', { city: '杭州' })
  now = 200
  const second = service.execute('weather', { city: '北京' })
  assert.equal(log[0].ended_at, null)
  assert.equal(log[1].ended_at, null)
  now = 300; pending.get('北京')(output)
  assert.equal(await second, output)
  now = 900; pending.get('杭州')(output)
  assert.equal(await first, output)
  assert.deepEqual(log.map(e => e.started_at), [100, 200])
  assert.deepEqual(log.map(e => e.ended_at), [900, 300])
  assert.deepEqual(log.map(e => e.service_calls.map(s => s.arguments)), [[['杭州']], [['北京']]])
  assert.deepEqual(log.map(e => e.service_calls[0].ended_at), [900, 300])
  const calls = measuredToolCalls(log, 100, 2)
  assert.deepEqual(calls.map(c => [c.started_ms, c.ended_ms, c.duration_ms]), [[0, 800, 800], [100, 200, 100]])
  assert.deepEqual(toolTiming(calls), { before_ms: 100, after_ms: 800 })
  assert.ok(calls.every(c => c.turn_index === 2 && c.path === 'backend'))
  assert.ok(calls.every(c => !('completed_ms' in c)))
})

test('抛出异常和业务失败也记录执行结束，返回内容不被观测包装改变', async () => {
  let now = 100
  const failure = new Error('网络故障')
  const output = { content: '天气查询失败' }
  const log = []
  const service = observeToolExecution({ services: {}, async execute(name) {
    now = 200
    if (name === 'throw') throw failure
    return output
  } }, { surface: 'frontend', toolLog: log, clock: () => now })
  await assert.rejects(service.execute('throw'), error => error === failure)
  now = 150
  assert.equal(await service.execute('weather'), output)
  assert.deepEqual(log.map(e => e.outcome), ['threw', 'returned_failure'])
  assert.deepEqual(log.map(e => e.ended_at), [200, 200])
  assert.deepEqual(toolTiming(measuredToolCalls(log, 100, 0)), { before_ms: 50, after_ms: 100 })
})

// 仅在自动化测试中拦截外网响应；生产 worker 不安装此拦截，也不使用这些数据。
test('example 默认实现经 MCP HTTP 进入高德请求，车控音乐保持本地原实现', async t => {
  const originalFetch = globalThis.fetch
  const requests = []
  let failWeather = false
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.hostname === '127.0.0.1') return originalFetch(input, init)
    requests.push(url.hostname)
    if (url.hostname === 'mcp.amap.com') {
      const { params } = JSON.parse(init.body)
      requests.push(params.name)
      const data = params.name === 'maps_weather'
        ? { city: '杭州', forecasts: [{ dayweather: '测试天气', daytemp: '23' }] }
        : { pois: [{ name: '西湖', location: '120.1,30.2' }] }
      return Response.json({ jsonrpc: '2.0', id: 1, result: failWeather
        ? { isError: true, content: [{ type: 'text', text: '高德服务不可用' }] }
        : { content: [{ type: 'text', text: JSON.stringify(data) }] } })
    }
    assert.equal(url.origin + url.pathname, 'https://restapi.amap.com/v3/direction/driving')
    return Response.json({ status: '1', route: { paths: [{ distance: '4321', duration: '321', steps: [] }] } })
  })
  const log = []
  const service = observeToolExecution(createVoiceService('example', { amapAvailable: true }), { surface: 'frontend', toolLog: log })
  const server = await startCockpitServiceServer({ service, port: 0 })
  try {
    const probe = await verifyLiveService(server.origin, 'frontend')
    assert.equal(probe.length, 2)
    assert.ok(requests.includes('maps_weather'))
    assert.ok(requests.includes('maps_text_search'))
    assert.ok(requests.includes('restapi.amap.com'))
    assert.equal(service.snapshot('preflight-frontend').navigation.route.distance, 4321)
    assert.equal(service.snapshot('preflight-frontend').weather.dayweather, '测试天气')
    assert.ok(log.every(c => c.ended_at >= c.started_at && c.outcome === 'returned'))
    assert.deepEqual(log.map(c => c.service_calls.map(s => s.name)), [['weather'], ['resolvePlace', 'drivingRoute']])
    const before = requests.length
    await service.execute('vehicle_climate_control', { action: 'start' })
    await service.execute('music_play', { query: '七里香' })
    assert.equal(requests.length, before)
    failWeather = true
    await assert.rejects(verifyLiveService(server.origin, 'frontend'), /Live MCP preflight failed/u)
    assert.equal(log.at(-1).outcome, 'returned_failure')
    assert.throws(() => createVoiceService('unknown'), /Unknown service mode/u)
  } finally {
    await server.close()
  }
})

test('车控音乐仅需模型凭据，天气导航或 setup 依赖仍需高德凭据', () => {
  const local = loadCases({ domain: 'vehicle,music' })
  assert.equal(local.length, 42)
  assert.deepEqual(liveDomainsFor(local), [])
  const env = { DASHSCOPE_API_KEY: 'test-only-not-a-key' }
  assert.doesNotThrow(() => assertVoiceCredentials(local, 'example', env))
  for (const domain of ['weather', 'navigation']) {
    const cases = loadCases({ domain })
    assert.deepEqual(liveDomainsFor(cases), [domain])
    assert.throws(() => assertVoiceCredentials(cases, 'example', env), /AMAP_MCP_KEY is required/u)
  }
  assert.deepEqual(liveDomainsFor([{ domain: 'music', setup_calls: [{ name: 'navigation_start' }] }]), ['navigation'])
  assert.throws(() => assertVoiceCredentials(local, 'example', {}), /DASHSCOPE_API_KEY is required/u)
})

test('缺少高德凭据可执行原车控音乐，误调天气明确失败且不发外网请求', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected network request') })
  const service = createVoiceService('example', { amapAvailable: false })
  const climate = await service.execute('vehicle_climate_control', { action: 'start' })
  assert.ok(climate.content)
  const music = await service.execute('music_play', { query: '七里香' })
  assert.ok(music.content)
  await assert.rejects(service.execute('weather', { city: '杭州' }), /AMAP_MCP_KEY is required/u)
  assert.deepEqual(await verifyLiveService('not-a-url', 'frontend', []), [])
  assert.equal(globalThis.fetch.mock.callCount(), 0)
})

test('完整真实服务入口缺少任一凭据都拒绝运行，不回退预置服务', async () => {
  const runner = fileURLToPath(new URL('../runner/run-voice-surface-compare.mjs', import.meta.url))
  for (const [modelKey, expected] of [['', /DASHSCOPE_API_KEY is required/u], ['test-only-not-a-key', /AMAP_MCP_KEY is required/u]]) {
    await assert.rejects(execFileAsync(process.execPath, [runner, '--suite', 'short'], {
      env: { ...process.env, DASHSCOPE_API_KEY: modelKey, AMAP_MCP_KEY: '' },
    }), error => { assert.match(error.stderr, expected); return true })
  }
})

test('双指标 HTML/CSV 包含领域、前后端差值与缺失值，不展示匹配评分', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cockpit-dual-table-test-'))
  try {
    const f = dualReport('frontend', 'nav_context_add_waypoint_014')
    const b = dualReport('backend', 'nav_context_add_waypoint_014')
    b.results[0].turns[1].executed_calls = []
    const comparison = buildCanonicalComparison(f, b)
    const out = join(root, 'report.json')
    await writeCanonicalTables({ comparison, realtime_model: 'test', agent_model: 'test' }, out)
    const html = await readFile(`${out}.html`, 'utf8')
    assert.match(html, /高德 MCP/u)
    assert.equal((html.match(/<table>/gu) || []).length, 2)
    assert.match(html, /<h2>执行前<\/h2>/u)
    assert.match(html, /<h2>执行后<\/h2>/u)
    assert.doesNotMatch(html, /前端工具匹配|case 级准确率|<th>.*执行结果/u)
    for (const [phase, label, other] of [['before', '执行前', '执行后'], ['after', '执行后', '执行前']]) {
      const csv = await readFile(`${out}.${phase}.csv`, 'utf8')
      assert.equal(csv.trim().split('\n').length, 3)
      assert.match(csv, /"导航"/u)
      assert.match(csv, /"—"/u)
      assert.match(csv, /第 2 轮/u)
      assert.ok(csv.includes(label))
      assert.ok(!csv.includes(other))
      assert.ok((await readFile(`${out}.${phase}.summary.csv`, 'utf8')).includes(label))
    }
    await writeCanonicalTables(combineReports(batchFixtures()), out)
    const mergedHtml = await readFile(`${out}.html`, 'utf8')
    assert.match(mergedHtml, /分批来源/u)
    assert.match(mergedHtml, /不是同一次连续运行/u)
    assert.match(mergedHtml, /batch-0\.json/u)
    assert.match(mergedHtml, /batch-1\.json/u)
    assert.equal((await readFile(`${out}.before.csv`, 'utf8')).trim().split('\n').length, 93)
    assert.equal((await readFile(`${out}.after.csv`, 'utf8')).trim().split('\n').length, 93)
    assert.equal((await readFile(`${out}.md`, 'utf8')).match(/^## /gmu).length, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('纯计时发布保留逐调用数据，可重算且不泄漏过程日志或评分', () => {
  const raw = combineReports(batchFixtures())
  raw.batch_sources[0].source = '/private/local/batch-0.json'
  const result = raw.frontend.results[0]
  result.trace = { events: ['private-marker'] }
  result.turns[0].executed_calls[0].result_content = 'private-marker'
  result.turns[0].executed_calls[0].error = 'private-marker'
  result.previous_attempt = structuredClone({ ...result, previous_attempt: undefined })
  raw.input = { voice: 'Tingting', cache_path: '/private/local' }
  const original = structuredClone(raw)
  const report = buildTimingReport(raw)
  assert.deepEqual(raw, original)
  assert.deepEqual(buildTimingReport(report), report)
  const serialized = JSON.stringify(report)
  assert.doesNotMatch(serialized, /private-marker|\/private\/local|result_content|"trace"|"score"|"task_success"|"outcome"/u)
  assert.equal(report.frontend.results[0].previous_attempt.turns[0].executed_calls[0].started_ms, 1000)
  assert.deepEqual(report.comparison.groups, raw.comparison.groups.map(({ frontend_failure_turn_count: _f,
    backend_failure_turn_count: _b, ...timing }) => timing))
  assert.deepEqual(report.comparison.tasks.map(r => [r.frontend_before_ms, r.backend_after_ms]),
    raw.comparison.tasks.map(r => [r.frontend_before_ms, r.backend_after_ms]))
  assert.throws(() => buildTimingReport({ suite: 'short', frontend: toolReport('frontend'), backend: toolReport('backend') }), /dual-timing/u)
})

test('提交的实测数据无需凭据即可离线重算，所有发布表与原始计时一致', async () => {
  const source = fileURLToPath(new URL('../results/voice-surface-short-20260911.json', import.meta.url))
  const data = JSON.parse(await readFile(source, 'utf8'))
  assert.deepEqual(buildTimingReport(data), data)
  for (const surface of ['frontend', 'backend']) {
    assert.equal(data[surface].results.length, 86)
    assert.equal(data[surface].results.reduce((n, result) => n + result.turns.length, 0), 111)
  }
  assert.deepEqual(data.comparison.groups.map(g => [g.total, g.frontend_before_count, g.backend_after_count]),
    [[92, 90, 68], [23, 23, 22], [17, 17, 15], [44, 44, 30], [8, 6, 1]])
  const root = await mkdtemp(join(tmpdir(), 'cockpit-timing-export-'))
  try {
    const out = join(root, 'voice-surface-short-20260911.json')
    const runner = fileURLToPath(new URL('../runner/run-voice-surface-compare.mjs', import.meta.url))
    await execFileAsync(process.execPath, [runner, '--from-report', source, '--timing-only', '--out', out], {
      env: { ...process.env, DASHSCOPE_API_KEY: '', AMAP_MCP_KEY: '' },
    })
    // 归一化换行：core.autocrlf 会把签出的发布文件转成 CRLF，而导出始终写 LF。
    const text = async path => (await readFile(path, 'utf8')).replaceAll('\r\n', '\n')
    for (const suffix of ['', '.md', '.html', '.before.csv', '.after.csv', '.before.summary.csv', '.after.summary.csv']) {
      assert.equal(await text(`${out}${suffix}`), await text(`${source}${suffix}`), suffix)
    }
    await assert.rejects(reanalyzeReport(source, out, { timingOnly: true }), /EEXIST/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('离线重算禁止覆盖原始报告', async () => {
  const source = fileURLToPath(new URL('../reports/source.json', import.meta.url))
  await assert.rejects(reanalyzeReport(source, source), /new output path/u)
})

test('error recovery preserves original attempts and forbids retrying scoring-only failures', () => {
  const item = loadCases({ caseId: 'veh_negative_ambiguous_open_024' })[0]
  const trace = { calls: [], final_state: createBenchmarkService().snapshot('recovery-test') }
  const failed = scoreCanonicalResult(item, trace, [], 'connection unavailable')
  const retried = scoreCanonicalResult(item, trace, [{ kind: 'no_tool_control', turn_settled_ms: 2000 }])
  const merged = mergeRecovery({ results: [failed] }, { results: [retried] })
  assert.equal(merged.results[0].previous_attempt, failed)
  assert.equal(merged.error_count, 0)
  assert.deepEqual(merged.recovery_ids, [item.id])
  assert.throws(() => mergeRecovery({ results: [{ ...failed, error: null }] }, { results: [retried] }),
    /only replace execution errors/u)
})
