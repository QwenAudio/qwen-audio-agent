#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { loadCockpitEnvironment } from '../../bootstrap/environment.mjs'
import { loadBenchmarkCases, routeCasesExpectedPaths } from '../evaluator/cases.mjs'
import { scoreTrace, summarizeScores } from '../evaluator/score.mjs'

function parseArgs(argv) {
  const args = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index].startsWith('--')) {
      args.set(argv[index].slice(2), argv[index + 1]?.startsWith('--') ? true : argv[++index])
    }
  }
  return args
}

async function replayCase(caseItem, { harness }) {
  const service = harness.createBenchmarkService()
  const cockpitId = caseItem.id
  await harness.setupBenchmarkCase(caseItem, { service, cockpitId })
  const calls = []
  const assistantMessages = []
  for (const expected of caseItem.expected_calls || []) {
    const output = await harness.executeBenchmarkTool({
      service,
      cockpitId,
      calls,
      turnIndex: expected.turn_index,
      name: expected.name,
      args: expected.arguments || {},
    })
    assistantMessages.push(output.content || '')
  }
  return {
    id: caseItem.id,
    calls,
    assistant_messages: assistantMessages,
    final_state: service.snapshot(cockpitId),
  }
}

async function main() {
  loadCockpitEnvironment()
  const args = parseArgs(process.argv.slice(2))
  const harness = await import('./controlled-harness.mjs')
  const { COCKPIT_SURFACE_ROUTING } = await import('../../service/tools/registry.mjs')
  const outPath = args.get('out')
  const domains = args.get('domain')
    ? String(args.get('domain')).split(',').map(item => item.trim()).filter(Boolean)
    : harness.BENCHMARK_DOMAINS
  const cases = routeCasesExpectedPaths(loadBenchmarkCases({ domains }), COCKPIT_SURFACE_ROUTING)
  const traces = []
  for (const caseItem of cases) {
    traces.push(await replayCase(caseItem, { harness }))
  }
  const scores = cases.map((caseItem, index) => scoreTrace(caseItem, traces[index]))
  const report = {
    suite: 'smart-cockpit/cockpit',
    mode: 'gold',
    domains,
    routing: COCKPIT_SURFACE_ROUTING.domains,
    created_at: new Date().toISOString(),
    summary: summarizeScores(scores),
    scores,
    traces,
  }

  if (outPath) {
    const absolute = resolve(String(outPath))
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, `${JSON.stringify(report, null, 2)}\n`)
  } else {
    console.log(JSON.stringify(report.summary, null, 2))
  }
}

main().catch(error => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
