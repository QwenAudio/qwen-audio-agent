#!/usr/bin/env node
// Single-surface (frontend / backend) tool route latency worker.
//
// Why a separate process: surface routing (COCKPIT_DOMAIN_SURFACES) is frozen into
// FRONTEND_TOOL_NAMES / BACKEND_TOOL_NAMES when registry.mjs loads, so one process
// cannot hold two routings. run-surface-compare.mjs therefore starts one worker per
// routing and this file handles exactly one of them.
//
// What is measured (no LLM involved; the model is a zero-latency stub):
//   frontend — client --MCP/HTTP--> /mcp/frontend --> CockpitService
//   backend  — client --A2A/JSON-RPC--> Agent --MCP/HTTP--> /mcp/backend --> CockpitService
// Both routes execute the same tool on the same CockpitService instance, so the
// difference is the route overhead itself.
//
// Usage (normally invoked by run-surface-compare.mjs):
//   COCKPIT_DOMAIN_SURFACES='{"domains":{"vehicle":"backend"}}' \
//     node surface-latency-worker.mjs --surface backend --repeats 5
import { readFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { A2ABackendAdapter } from 'qwen-audio-agent/a2a-backend-adapter'
import { CockpitServiceServer } from '../../service/server.mjs'
import { startCockpitAgentServer } from '../../agent/server.mjs'
import { surfaceForCockpitTool } from '../../service/tools/registry.mjs'
import { createBenchmarkService, parseRunnerArgs, numberArg } from './controlled-harness.mjs'

const CASES_URL = new URL('../cases/surface-compare.jsonl', import.meta.url)
const COCKPIT_ID = 'surface-latency'

function loadCases({ domain } = {}) {
  const all = readFileSync(CASES_URL, 'utf8')
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line))
  if (!domain || domain === 'all') return all
  const domains = new Set(String(domain).split(',').map(part => part.trim()))
  return all.filter(caseItem => domains.has(caseItem.domain))
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

const round3 = value => (value == null ? null : Math.round(value * 1000) / 1000)

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    samples: samples.length,
    min_ms: round3(sorted[0]),
    median_ms: round3(quantile(sorted, 0.5)),
    p95_ms: round3(quantile(sorted, 0.95)),
    max_ms: round3(sorted[sorted.length - 1]),
    mean_ms: round3(samples.reduce((total, value) => total + value, 0) / samples.length),
  }
}

// ─── Zero-latency stub model: maps an utterance to the case's declared calls ──
// This removes model inference from the measurement, leaving only the route cost
// (A2A + MCP + Agent orchestration).
function scriptedModel(cases) {
  const script = new Map(cases.map(caseItem => [
    caseItem.turns[0].user,
    (caseItem.explicit_calls || []).map((call, index) => ({
      id: `call-${caseItem.id}-${index}`,
      type: 'function',
      function: {
        name: call.name,
        arguments: JSON.stringify(call.arguments || {}),
      },
    })),
  ]))
  return {
    model: 'scripted-stub',
    async complete({ messages }) {
      const last = messages.at(-1)
      if (last?.role === 'tool') return { content: String(last.content || '') }
      const objective = String(last?.content || '')
      const calls = script.get(objective)
      if (!calls?.length) return { content: 'no matching tool' }
      return { content: null, tool_calls: calls }
    },
  }
}

// ─── frontend route: MCP over HTTP ───────────────────────────────────────────
async function createFrontendDriver({ serviceOrigin }) {
  const url = new URL('/mcp/frontend', serviceOrigin)
  url.searchParams.set('cockpitId', COCKPIT_ID)
  const client = new Client({ name: 'surface-latency-probe', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(url))
  const available = new Set((await client.listTools()).tools.map(tool => tool.name))
  return {
    label: 'MCP/HTTP -> /mcp/frontend',
    supports: name => available.has(name),
    async run(caseItem) {
      // On the frontend route one utterance maps to one tool call, matching how the
      // Gateway talks to MCP directly.
      for (const call of caseItem.explicit_calls || []) {
        const result = await client.callTool({
          name: call.name,
          arguments: call.arguments || {},
        })
        if (result.isError) {
          throw new Error(`frontend tool failed: ${call.name}: ${result.content?.[0]?.text}`)
        }
      }
    },
    close: () => client.close(),
  }
}

// ─── backend route: A2A -> Agent -> MCP over HTTP ────────────────────────────
async function createBackendDriver({ serviceOrigin, cases }) {
  const agent = await startCockpitAgentServer({
    port: 0,
    serviceOrigin,
    cockpitId: COCKPIT_ID,
    model: scriptedModel(cases),
  })
  const backend = new A2ABackendAdapter({
    agentCardUrl: agent.agentCardUrl,
    pollIntervalMs: 10,
  })
  let taskSeq = 0
  return {
    label: 'A2A -> Agent -> MCP/HTTP -> /mcp/backend',
    supports: () => true,
    async run(caseItem) {
      const outcome = await backend.submit({
        id: `surface-latency-${taskSeq += 1}`,
        ownerId: 'surface-latency',
        objective: caseItem.turns[0].user,
      })
      if (outcome?.state && /fail/iu.test(String(outcome.state))) {
        throw new Error(`backend task failed: ${outcome.content}`)
      }
    },
    close: async () => {
      await backend.close()
      await agent.close()
    },
  }
}

// ─── main ────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseRunnerArgs(process.argv.slice(2))
  const surface = String(args.get('surface') || 'frontend')
  const repeats = numberArg(args, 'repeats', 5)
  const warmup = numberArg(args, 'warmup', 2)
  const domain = args.get('domain') ? String(args.get('domain')) : null
  const cases = loadCases({ domain })

  const service = createBenchmarkService()
  const server = new CockpitServiceServer({ service, port: 0 })
  await server.start()

  const driver = surface === 'backend'
    ? await createBackendDriver({ serviceOrigin: server.origin, cases })
    : await createFrontendDriver({ serviceOrigin: server.origin })

  const results = []
  const skipped = []

  for (const caseItem of cases) {
    // Skip tools that do not exist on this surface, so "tool not visible" is never
    // recorded as latency.
    const unavailable = (caseItem.explicit_calls || [])
      .map(call => call.name)
      .filter(name => !driver.supports(name))
    if (unavailable.length) {
      skipped.push({ id: caseItem.id, reason: `not on ${surface} surface`, tools: unavailable })
      continue
    }

    const samples = []
    for (let iteration = 0; iteration < warmup + repeats; iteration += 1) {
      // Setup goes through the in-process service and stays outside the measured window.
      for (const call of caseItem.setup_calls || []) {
        await service.execute(call.name, call.arguments || {}, { cockpitId: COCKPIT_ID })
      }
      const started = performance.now()
      await driver.run(caseItem)
      const elapsed = performance.now() - started
      if (iteration >= warmup) samples.push(elapsed)
    }

    results.push({
      id: caseItem.id,
      domain: caseItem.domain,
      tool: caseItem.tool,
      call_count: (caseItem.explicit_calls || []).length,
      routed_surface: surfaceForCockpitTool(caseItem.explicit_calls?.[0]?.name) || null,
      ...summarize(samples),
    })
    process.stderr.write(`  ✓ [${surface}] ${caseItem.id} median=${results.at(-1).median_ms}ms\n`)
  }

  const byDomain = {}
  for (const result of results) {
    byDomain[result.domain] ||= []
    byDomain[result.domain].push(result.median_ms)
  }
  const domainSummary = Object.fromEntries(
    Object.entries(byDomain).map(([name, medians]) => [name, {
      case_count: medians.length,
      ...summarize(medians),
    }]),
  )

  const report = {
    surface,
    path: driver.label,
    repeats,
    warmup,
    case_count: results.length,
    skipped,
    overall: results.length ? summarize(results.map(result => result.median_ms)) : null,
    domainSummary,
    results,
  }

  await driver.close()
  await server.close()
  process.stdout.write(`${JSON.stringify(report)}\n`)
}

main().catch(error => {
  process.stderr.write(`${error?.stack || error}\n`)
  process.exitCode = 1
})
