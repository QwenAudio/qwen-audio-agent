#!/usr/bin/env node
// Frontend/backend tool execution speed comparison.
//
// Three measurement modes, layering from "pure execution" up to "the full route":
//   1. direct    — bypasses the model and the network, calling
//                  CockpitService.execute() in process. It is the baseline proving
//                  both surfaces share one executor, so execution itself is neither
//                  faster nor slower on either side.
//   2. transport — the same tool over the real frontend and backend routes with the
//                  model replaced by a zero-latency stub, so the difference is the
//                  route cost itself (A2A + Agent orchestration + MCP):
//                    frontend: client --MCP/HTTP--> /mcp/frontend --> Service
//                    backend : client --A2A--> Agent --MCP/HTTP--> /mcp/backend --> Service
//                  The backend route needs the domain routing flipped to backend, and
//                  surface routing is frozen at module load, so this mode spawns one
//                  worker process per routing.
//   3. model     — adds real model inference: the frontend is one hop (the model picks
//                  the tool directly) while the backend is two (the gateway model
//                  decides to delegate through spawn_thinking, then the Agent model
//                  picks the tool). Requires DASHSCOPE_API_KEY.
//
// Usage:
//   node run-surface-compare.mjs                        # direct + transport, plus model when a key is set
//   node run-surface-compare.mjs --mode direct          # in-process execution baseline only
//   node run-surface-compare.mjs --mode transport       # route comparison only, no API key needed
//   node run-surface-compare.mjs --mode model           # model hop comparison only, API key needed
//   node run-surface-compare.mjs --domain vehicle       # vehicle domain only
//   node run-surface-compare.mjs --repeats 5            # repeat each case 5 times and take the median
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { loadCockpitEnvironment } from '../../bootstrap/environment.mjs'
import {
  COCKPIT_TOOL_DEFINITIONS,
  FRONTEND_TOOL_NAMES,
  BACKEND_TOOL_NAMES,
} from '../../service/tools/registry.mjs'

// ─── CLI arguments ───────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = new Map()
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i]
    if (!raw.startsWith('--')) continue
    const key = raw.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) { args.set(key, true); continue }
    args.set(key, next); i += 1
  }
  return args
}

// ─── Tool set construction ───────────────────────────────────────────────────
function openAiTool(tool) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || tool.title || tool.name,
      parameters: tool.inputSchema || { type: 'object', properties: {} },
    },
  }
}

function buildAllToolSet() {
  return COCKPIT_TOOL_DEFINITIONS.map(openAiTool)
}

// ─── Case loading ────────────────────────────────────────────────────────────
const CASES_URL = new URL('../cases/surface-compare.jsonl', import.meta.url)

function parseJsonl(text) {
  return text.split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line))
}

function loadCases({ domain } = {}) {
  const all = parseJsonl(readFileSync(CASES_URL, 'utf8'))
  if (!domain || domain === 'all') return all
  const domains = new Set(domain.split(',').map(d => d.trim()))
  return all.filter(c => domains.has(c.domain))
}

// ─── Deterministic benchmark service (reuses controlled-harness) ─────────────
async function createBenchmarkService() {
  const { createBenchmarkService: create } = await import('./controlled-harness.mjs')
  return create()
}

async function setupCase(caseItem, service, cockpitId) {
  for (const call of caseItem.setup_calls || []) {
    await service.execute(call.name, call.arguments || {}, { cockpitId })
  }
}

// ─── High-resolution timing ──────────────────────────────────────────────────
function hrtimeMs() {
  const [s, ns] = process.hrtime()
  return s * 1000 + ns / 1_000_000
}

async function measureToolExecution(service, cockpitId, name, args) {
  const t0 = hrtimeMs()
  const result = await service.execute(name, args || {}, { cockpitId })
  const elapsed = hrtimeMs() - t0
  return { elapsed, result }
}

// ─── Phase 1: direct tool execution latency ──────────────────────────────────
async function runDirectMode(cases, { repeats = 3 }) {
  process.stderr.write('\n━━━ Phase 1: direct tool execution latency ━━━\n')
  const service = await createBenchmarkService()
  const results = []

  for (const caseItem of cases) {
    const caseResult = {
      id: caseItem.id,
      domain: caseItem.domain,
      tool: caseItem.tool,
      calls: [],
    }

    for (const call of caseItem.explicit_calls || []) {
      const callTimings = []
      for (let r = 0; r < repeats; r += 1) {
        // Reset the state before each repeat so runs cannot contaminate each other
        const cockpitId = `${caseItem.id}_${r}`
        await setupCase(caseItem, service, cockpitId)
        const { elapsed } = await measureToolExecution(
          service, cockpitId, call.name, call.arguments,
        )
        callTimings.push(elapsed)
      }
      const sorted = [...callTimings].sort((a, b) => a - b)
      const median = sorted.length % 2
        ? sorted[Math.floor(sorted.length / 2)]
        : Math.round((sorted[Math.floor(sorted.length / 2) - 1] + sorted[Math.floor(sorted.length / 2)]) / 2 * 100) / 100
      caseResult.calls.push({
        name: call.name,
        timings_ms: callTimings.map(t => Math.round(t * 100) / 100),
        median_ms: median,
        min_ms: Math.round(sorted[0] * 100) / 100,
        max_ms: Math.round(sorted[sorted.length - 1] * 100) / 100,
      })
    }
    results.push(caseResult)
    process.stderr.write(`  ✓ ${caseItem.id} (${caseResult.calls.map(c => `${c.median_ms}ms`).join(', ')})\n`)
  }

  // Per-domain summary
  const domainSummary = {}
  for (const r of results) {
    const key = r.domain
    if (!domainSummary[key]) domainSummary[key] = { count: 0, total_median: 0 }
    for (const c of r.calls) {
      domainSummary[key].count += 1
      domainSummary[key].total_median += c.median_ms
    }
  }
  for (const key of Object.keys(domainSummary)) {
    const s = domainSummary[key]
    s.avg_median_ms = Math.round(s.total_median / s.count * 100) / 100
    delete s.total_median
  }

  return { results, domainSummary }
}

// ─── Phase 2: real route latency (frontend MCP vs backend A2A+MCP, no model) ─
const WORKER_URL = new URL('./surface-latency-worker.mjs', import.meta.url)

// Flip a whole domain onto one surface. Surface routing works per domain and has no
// per-tool granularity, so running vehicle/music/navigation over the backend route
// means moving the entire domain to backend.
function domainSurfaceOverride(surface) {
  return JSON.stringify({
    domains: {
      vehicle: surface,
      music: surface,
      navigation: surface,
      weather: surface,
    },
  })
}

function runWorker({ surface, repeats, warmup, domain }) {
  const args = [
    fileURLToPath(WORKER_URL),
    '--surface', surface,
    '--repeats', String(repeats),
    '--warmup', String(warmup),
  ]
  if (domain) args.push('--domain', domain)
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, COCKPIT_DOMAIN_SURFACES: domainSurfaceOverride(surface) },
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.once('error', rejectPromise)
    child.once('close', code => {
      if (code !== 0) {
        rejectPromise(new Error(`surface worker (${surface}) exited with code ${code}`))
        return
      }
      const line = stdout.trim().split(/\r?\n/u).at(-1)
      try {
        resolvePromise(JSON.parse(line))
      } catch (error) {
        rejectPromise(new Error(`surface worker (${surface}) produced no report: ${error.message}`))
      }
    })
  })
}

async function runTransportMode(cases, { repeats = 5, warmup = 2, domain = null }) {
  process.stderr.write('\n━━━ Phase 2: real route latency (no model) ━━━\n')
  const [frontend, backend] = await Promise.all([
    runWorker({ surface: 'frontend', repeats, warmup, domain }),
    runWorker({ surface: 'backend', repeats, warmup, domain }),
  ])

  const backendById = new Map(backend.results.map(result => [result.id, result]))
  const comparison = frontend.results
    .filter(result => backendById.has(result.id))
    .map(result => {
      const peer = backendById.get(result.id)
      return {
        id: result.id,
        domain: result.domain,
        tool: result.tool,
        frontend_median_ms: result.median_ms,
        backend_median_ms: peer.median_ms,
        delta_ms: Math.round((peer.median_ms - result.median_ms) * 1000) / 1000,
        ratio: result.median_ms > 0
          ? Math.round(peer.median_ms / result.median_ms * 100) / 100
          : null,
      }
    })

  return { frontend, backend, comparison }
}

function printTransportSummary(phase2) {
  const { frontend, backend, comparison } = phase2
  console.log('\n┌──────────────────────────────────────────────────────────────────────────┐')
  console.log('│  Phase 2: one tool over the real frontend vs backend route (no model)    │')
  console.log('├──────────────────────────────────────────────────────────────────────────┤')
  console.log(`│  frontend: ${frontend.path}`.padEnd(75) + '│')
  console.log(`│  backend : ${backend.path}`.padEnd(75) + '│')
  console.log('├────────────┬────────┬─────────────┬─────────────┬─────────────┬─────────┤')
  console.log('│ Domain     │  Cases │  Frontend   │   Backend   │      Δ      │  Ratio  │')
  console.log('├────────────┼────────┼─────────────┼─────────────┼─────────────┼─────────┤')

  const domains = [...new Set(comparison.map(row => row.domain))]
  for (const domain of domains) {
    const rows = comparison.filter(row => row.domain === domain)
    const avg = key => rows.reduce((total, row) => total + row[key], 0) / rows.length
    const frontendAvg = avg('frontend_median_ms')
    const backendAvg = avg('backend_median_ms')
    console.log(
      `│ ${domain.padEnd(10)} │ ${String(rows.length).padStart(6)} │ `
      + `${(frontendAvg.toFixed(2) + 'ms').padStart(11)} │ ${(backendAvg.toFixed(2) + 'ms').padStart(11)} │ `
      + `${('+' + (backendAvg - frontendAvg).toFixed(2) + 'ms').padStart(11)} │ `
      + `${(backendAvg / frontendAvg).toFixed(2).padStart(6)}x │`,
    )
  }

  const overallFrontend = frontend.overall?.median_ms ?? 0
  const overallBackend = backend.overall?.median_ms ?? 0
  console.log('├────────────┼────────┼─────────────┼─────────────┼─────────────┼─────────┤')
  console.log(
    `│ ${'ALL'.padEnd(10)} │ ${String(comparison.length).padStart(6)} │ `
    + `${(overallFrontend.toFixed(2) + 'ms').padStart(11)} │ ${(overallBackend.toFixed(2) + 'ms').padStart(11)} │ `
    + `${('+' + (overallBackend - overallFrontend).toFixed(2) + 'ms').padStart(11)} │ `
    + `${(overallBackend / overallFrontend).toFixed(2).padStart(6)}x │`,
  )
  console.log('└────────────┴────────┴─────────────┴─────────────┴─────────────┴─────────┘')
  console.log('\n  Note: both routes call the same tool on the same CockpitService with a')
  console.log('  zero-latency stub model, so Δ is the pure route cost: the A2A JSON-RPC round')
  console.log('  trip, the Agent\'s per-task tools.list and custom_skill_list probes, and its')
  console.log('  orchestration rounds. That is the fixed entry fee for "put it in the backend";')
  console.log('  a real deployment adds one more model inference on top (see Phase 3).')
  if (frontend.skipped.length || backend.skipped.length) {
    console.log(`\n  skipped: frontend ${frontend.skipped.length} / backend ${backend.skipped.length}`)
  }
}

// ─── Phase 3: model inference plus tool execution latency ────────────────────
async function runModelMode(cases, { repeats = 1, requestTimeoutMs = 60_000 }) {
  if (!process.env.DASHSCOPE_API_KEY) {
    process.stderr.write('\n⚠ skipping Phase 3: DASHSCOPE_API_KEY is not set\n')
    process.stderr.write('  to measure model inference latency, set the environment variable first:\n')
    process.stderr.write('    export DASHSCOPE_API_KEY=your-key\n')
    return { skipped: true, reason: 'DASHSCOPE_API_KEY not set' }
  }

  const { DashScopeCockpitModel } = await import('../../agent/model.mjs')
  const { COCKPIT_AGENT_PROMPT } = await import('../../agent/executor.mjs')
  const { spawnThinkingTool } = await import('../../../../server/src/frontend/tools/spawn-thinking-tool.mjs')
  const { COCKPIT_SPAWN_THINKING_DESCRIPTION } = await import('../../gateway/spawn-thinking-tool.mjs')
  const service = await createBenchmarkService()
  const model = new DashScopeCockpitModel()

  process.stderr.write('\n━━━ Phase 3: model inference hop comparison ━━━\n')
  process.stderr.write(`  model: ${model.model}\n`)

  // Frontend route: the model sees the domain tools directly and one inference is
  // enough to pick and execute.
  const domainTools = buildAllToolSet()
    .filter(tool => !tool.function.name.startsWith('custom_skill'))
  // First backend hop: the gateway only sees the delegation tool, so it has to decide
  // on spawn_thinking first.
  const delegationTools = [{
    ...spawnThinkingTool,
    function: {
      ...spawnThinkingTool.function,
      description: COCKPIT_SPAWN_THINKING_DESCRIPTION,
    },
  }]

  async function completeOnce({ tools, user, systemPrompt }) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs)
    const started = hrtimeMs()
    try {
      const response = await model.complete({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: user },
        ],
        tools,
        signal: controller.signal,
      })
      return { elapsed: hrtimeMs() - started, response }
    } finally {
      clearTimeout(timer)
    }
  }

  async function executeToolCalls({ response, cockpitId, allowed }) {
    const calls = Array.isArray(response.tool_calls) ? response.tool_calls : []
    let elapsed = 0
    const names = []
    for (const call of calls) {
      const name = String(call?.function?.name || '')
      names.push(name)
      if (!allowed.has(name)) continue
      let args
      try { args = JSON.parse(call?.function?.arguments || '{}') } catch { args = {} }
      const started = hrtimeMs()
      await service.execute(name, args, { cockpitId })
      elapsed += hrtimeMs() - started
    }
    return { elapsed, names }
  }

  const domainToolNames = new Set(domainTools.map(tool => tool.function.name))
  const results = []

  for (const caseItem of cases) {
    const user = caseItem.turns[0].user
    const runs = []

    for (let iteration = 0; iteration < repeats; iteration += 1) {
      try {
        // ── frontend: 1 hop ──
        const frontendCockpitId = `${caseItem.id}_frontend_${iteration}`
        await setupCase(caseItem, service, frontendCockpitId)
        const frontendHop = await completeOnce({
          tools: domainTools,
          user,
          systemPrompt: COCKPIT_AGENT_PROMPT,
        })
        const frontendExec = await executeToolCalls({
          response: frontendHop.response,
          cockpitId: frontendCockpitId,
          allowed: domainToolNames,
        })

        // ── backend: 2 hops (gateway delegation + Agent tool choice) ──
        const backendCockpitId = `${caseItem.id}_backend_${iteration}`
        await setupCase(caseItem, service, backendCockpitId)
        const delegationHop = await completeOnce({
          tools: delegationTools,
          user,
          systemPrompt: COCKPIT_AGENT_PROMPT,
        })
        const agentHop = await completeOnce({
          tools: domainTools,
          user,
          systemPrompt: COCKPIT_AGENT_PROMPT,
        })
        const backendExec = await executeToolCalls({
          response: agentHop.response,
          cockpitId: backendCockpitId,
          allowed: domainToolNames,
        })

        runs.push({
          frontend_model_ms: Math.round(frontendHop.elapsed * 100) / 100,
          frontend_exec_ms: Math.round(frontendExec.elapsed * 100) / 100,
          frontend_total_ms: Math.round((frontendHop.elapsed + frontendExec.elapsed) * 100) / 100,
          frontend_tools: frontendExec.names,
          backend_delegation_ms: Math.round(delegationHop.elapsed * 100) / 100,
          backend_agent_ms: Math.round(agentHop.elapsed * 100) / 100,
          backend_exec_ms: Math.round(backendExec.elapsed * 100) / 100,
          backend_total_ms: Math.round(
            (delegationHop.elapsed + agentHop.elapsed + backendExec.elapsed) * 100,
          ) / 100,
          backend_tools: backendExec.names,
          delegated: delegationHop.response.tool_calls?.some(
            call => call?.function?.name === 'spawn_thinking',
          ) === true,
        })
      } catch (error) {
        process.stderr.write(`    ✗ ${caseItem.id}: ${error.message}\n`)
        break
      }
    }

    if (!runs.length) continue
    const mean = key => Math.round(
      runs.reduce((total, run) => total + run[key], 0) / runs.length * 100,
    ) / 100
    const result = {
      id: caseItem.id,
      domain: caseItem.domain,
      tool: caseItem.tool,
      frontend_total_ms: mean('frontend_total_ms'),
      backend_total_ms: mean('backend_total_ms'),
      delta_ms: Math.round((mean('backend_total_ms') - mean('frontend_total_ms')) * 100) / 100,
      delegation_rate: runs.filter(run => run.delegated).length / runs.length,
      runs,
    }
    results.push(result)
    process.stderr.write(
      `    ✓ ${caseItem.id}: frontend=${result.frontend_total_ms}ms `
      + `backend=${result.backend_total_ms}ms Δ=+${result.delta_ms}ms\n`,
    )
  }

  const domainSummary = {}
  for (const result of results) {
    domainSummary[result.domain] ||= { count: 0, frontend: 0, backend: 0 }
    domainSummary[result.domain].count += 1
    domainSummary[result.domain].frontend += result.frontend_total_ms
    domainSummary[result.domain].backend += result.backend_total_ms
  }
  for (const summary of Object.values(domainSummary)) {
    summary.avg_frontend_ms = Math.round(summary.frontend / summary.count * 100) / 100
    summary.avg_backend_ms = Math.round(summary.backend / summary.count * 100) / 100
    summary.avg_delta_ms = Math.round(
      (summary.avg_backend_ms - summary.avg_frontend_ms) * 100,
    ) / 100
    delete summary.frontend
    delete summary.backend
  }

  return {
    model: model.model,
    frontend_tool_count: domainTools.length,
    results,
    domainSummary,
  }
}

// ─── Summary output ──────────────────────────────────────────────────────────
async function printDirectSummary(phase1) {
  // Import the surface information
  let surfaceForTool
  try {
    const registry = await import('../../service/tools/registry.mjs')
    surfaceForTool = registry.surfaceForCockpitTool
  } catch { surfaceForTool = () => null }

  console.log('\n┌──────────────────────────────────────────────────────────────────────────┐')
  console.log('│        Phase 1: direct tool execution latency (CockpitService.execute)   │')
  console.log('├────────────────────────────┬───────────┬──────────┬──────────┬───────────┤')
  console.log('│ Tool                       │ Surface   │  Median  │   Min    │   Max     │')
  console.log('├────────────────────────────┼───────────┼──────────┼──────────┼───────────┤')

  for (const r of phase1.results) {
    for (const c of r.calls) {
      const surface = surfaceForTool(c.name) || '?'
      const label = c.name.length > 26 ? c.name.slice(0, 24) + '..' : c.name
      console.log(
        `│ ${label.padEnd(26)} │ ${surface.padEnd(9)} │ ${(c.median_ms.toFixed(3) + 'ms').padStart(8)} │ ${(c.min_ms.toFixed(3) + 'ms').padStart(8)} │ ${(c.max_ms.toFixed(3) + 'ms').padStart(8)} │`,
      )
    }
  }

  console.log('├────────────────────────────┴───────────┴──────────┴──────────┴───────────┤')

  // Per-domain summary
  console.log('│ By domain:                                                           │')
  for (const [domain, summary] of Object.entries(phase1.domainSummary)) {
    const allMedians = phase1.results
      .filter(r => r.domain === domain)
      .flatMap(r => r.calls.map(c => c.median_ms))
    const min = Math.min(...allMedians).toFixed(3)
    const max = Math.max(...allMedians).toFixed(3)
    console.log(
      `│   ${domain.padEnd(10)} ${String(summary.count).padStart(3)} tools  avg=${summary.avg_median_ms.toFixed(3)}ms  range=${min}~${max}ms`.padEnd(72) + '│',
    )
  }

  const allMedians = phase1.results.flatMap(r => r.calls.map(c => c.median_ms))
  const overallAvg = (allMedians.reduce((a, b) => a + b, 0) / allMedians.length).toFixed(3)
  console.log('├──────────────────────────────────────────────────────────────────────────┤')
  console.log(
    `│  TOTAL: ${allMedians.length} tools  avg=${overallAvg}ms  range=${Math.min(...allMedians).toFixed(3)}~${Math.max(...allMedians).toFixed(3)}ms`.padEnd(72) + '│',
  )
  console.log('└──────────────────────────────────────────────────────────────────────────┘')
  console.log('\n  Note: this is the in-process baseline, so both surfaces must report the same')
  console.log('  numbers: they share one CockpitService executor and "execution" itself is')
  console.log('  neither faster nor slower. The real differences are the route cost (Phase 2)')
  console.log('  and the model hops (Phase 3).')
}

function printModelSummary(phase3) {
  if (phase3.skipped) {
    console.log(`\n  Phase 3 skipped: ${phase3.reason}`)
    return
  }
  console.log('\n┌──────────────────────────────────────────────────────────────────────────┐')
  console.log(`│  Phase 3: model inference hop comparison  (model: ${phase3.model})`.padEnd(75) + '│')
  console.log('│  frontend = 1 hop (direct tool choice)  backend = 2 hops (delegate + Agent) │')
  console.log('├────────────┬────────┬──────────────┬──────────────┬──────────────────────┤')
  console.log('│ Domain     │  Cases │  Frontend    │   Backend    │      Δ               │')
  console.log('├────────────┼────────┼──────────────┼──────────────┼──────────────────────┤')
  for (const [domain, summary] of Object.entries(phase3.domainSummary)) {
    console.log(
      `│ ${domain.padEnd(10)} │ ${String(summary.count).padStart(6)} │ `
      + `${(summary.avg_frontend_ms.toFixed(0) + 'ms').padStart(12)} │ `
      + `${(summary.avg_backend_ms.toFixed(0) + 'ms').padStart(12)} │ `
      + `${('+' + summary.avg_delta_ms.toFixed(0) + 'ms').padStart(20)} │`,
    )
  }
  const totals = Object.values(phase3.domainSummary)
  if (totals.length) {
    const weight = totals.reduce((total, summary) => total + summary.count, 0)
    const frontendAvg = totals.reduce(
      (total, summary) => total + summary.avg_frontend_ms * summary.count, 0,
    ) / weight
    const backendAvg = totals.reduce(
      (total, summary) => total + summary.avg_backend_ms * summary.count, 0,
    ) / weight
    console.log('├────────────┼────────┼──────────────┼──────────────┼──────────────────────┤')
    console.log(
      `│ ${'ALL'.padEnd(10)} │ ${String(weight).padStart(6)} │ `
      + `${(frontendAvg.toFixed(0) + 'ms').padStart(12)} │ `
      + `${(backendAvg.toFixed(0) + 'ms').padStart(12)} │ `
      + `${('+' + (backendAvg - frontendAvg).toFixed(0) + 'ms').padStart(20)} │`,
    )
  }
  console.log('└────────────┴────────┴──────────────┴──────────────┴──────────────────────┘')

  const delegated = phase3.results.filter(result => result.delegation_rate > 0).length
  console.log(`\n  Delegation: the gateway model actually called spawn_thinking in ${delegated}/${phase3.results.length} cases.`)
  console.log('  A low delegation rate means these atomic commands belong on the frontend by')
  console.log('  the architecture criteria and should not be routed to the backend.')
  console.log('  Note: Phase 3 covers model inference and local execution only, without the')
  console.log('  Phase 2 route cost; real backend end-to-end ≈ Phase 3 backend + Phase 2 Δ.')
}

// ─── main ────────────────────────────────────────────────────────────────────
async function main() {
  loadCockpitEnvironment()
  const args = parseArgs(process.argv.slice(2))
  const mode = String(args.get('mode') || 'all')
  const domain = args.get('domain') ? String(args.get('domain')) : null
  const repeats = Number(args.get('repeats') || (mode === 'model' ? 1 : 5)) || 1
  const warmup = Number(args.get('warmup') ?? 2) || 0
  const outPath = args.get('out')
    || 'examples/smart-cockpit/bench/reports/surface-compare-latest.json'

  const cases = loadCases({ domain })
  if (!cases.length) {
    console.error('No cases matched the filter')
    process.exitCode = 1
    return
  }
  process.stderr.write(`Loaded ${cases.length} cases`)
  if (domain) process.stderr.write(` (domain: ${domain})`)
  process.stderr.write('\n')

  const report = {
    kind: 'surface-compare',
    mode,
    created_at: new Date().toISOString(),
    case_count: cases.length,
    repeats,
    frontend_tool_count: FRONTEND_TOOL_NAMES.length,
    backend_tool_count: BACKEND_TOOL_NAMES.length,
  }

  if (mode === 'direct' || mode === 'all') {
    report.phase1_direct = await runDirectMode(cases, { repeats })
    await printDirectSummary(report.phase1_direct)
  }

  if (mode === 'transport' || mode === 'all') {
    report.phase2_transport = await runTransportMode(cases, { repeats, warmup, domain })
    printTransportSummary(report.phase2_transport)
  }

  // In all mode a missing API key skips silently, so the default path needs no
  // credentials.
  if (mode === 'model' || (mode === 'all' && process.env.DASHSCOPE_API_KEY)) {
    report.phase3_model = await runModelMode(cases, {
      repeats: mode === 'all' ? 1 : repeats,
    })
    printModelSummary(report.phase3_model)
  }

  const absolute = resolve(String(outPath))
  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(absolute, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`\nreport: ${absolute}`)
}

main().catch(error => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
