#!/usr/bin/env node
// 单表面（前台 / 后台）工具链路延迟测量 worker。
//
// 为什么要独立进程：表面路由（COCKPIT_DOMAIN_SURFACES）在 registry.mjs 模块加载期
// 固化成 FRONTEND_TOOL_NAMES / BACKEND_TOOL_NAMES，同一进程内无法加载两套路由。
// 因此 run-surface-compare.mjs 为每种路由各启动一个 worker，本文件只负责一种。
//
// 测量口径（不依赖任何 LLM，模型被替换为零耗时 stub）：
//   frontend —— 客户端 --MCP/HTTP--> /mcp/frontend --> CockpitService
//   backend  —— 客户端 --A2A/JSON-RPC--> Agent --MCP/HTTP--> /mcp/backend --> CockpitService
// 两条链路执行的是同一个工具、同一个 CockpitService 实例，因此差值即链路开销本身。
//
// 用法（一般由 run-surface-compare.mjs 调用）：
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

// ─── 统计 ────────────────────────────────────────────────────────────────────
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

// ─── 零耗时 stub 模型：把用户话术直接映射为用例声明的工具调用 ────────────────
// 目的是把模型推理时间从测量中剔除，只保留链路（A2A + MCP + Agent 编排）开销。
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
      if (!calls?.length) return { content: '无对应工具' }
      return { content: null, tool_calls: calls }
    },
  }
}

// ─── frontend 链路：MCP over HTTP ────────────────────────────────────────────
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
      // 前台链路一次话术对应一次工具调用，与 Gateway 直连 MCP 的行为一致。
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

// ─── backend 链路：A2A -> Agent -> MCP over HTTP ─────────────────────────────
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
    // 该表面上不存在这些工具时跳过，避免把 "工具不可见" 记成延迟。
    const unavailable = (caseItem.explicit_calls || [])
      .map(call => call.name)
      .filter(name => !driver.supports(name))
    if (unavailable.length) {
      skipped.push({ id: caseItem.id, reason: `not on ${surface} surface`, tools: unavailable })
      continue
    }

    const samples = []
    for (let iteration = 0; iteration < warmup + repeats; iteration += 1) {
      // setup 走进程内 service，不计入测量窗口。
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
