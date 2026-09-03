#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { DashScopeCockpitModel } from '../../agent/model.mjs'
import { loadCockpitEnvironment } from '../../bootstrap/environment.mjs'
import { loadBenchmarkCases, routeCasesExpectedPaths } from '../evaluator/cases.mjs'
import { scoreTrace, summarizeScores } from '../evaluator/score.mjs'

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000

async function completeWithTimeout(model, request, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await model.complete({ ...request, signal: controller.signal })
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`Model request timed out after ${timeoutMs}ms`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function runCase(caseItem, {
  model,
  harness,
  domains,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
}) {
  const service = harness.createBenchmarkService()
  const cockpitId = caseItem.id
  await harness.setupBenchmarkCase(caseItem, { service, cockpitId })

  const tools = harness.benchmarkTools({ domains })
  const messages = [{ role: 'system', content: harness.cockpitBenchmarkPrompt({ domains }) }]
  const calls = []
  const assistantMessages = []

  try {
    for (const [turnIndex, turn] of caseItem.turns.entries()) {
      messages.push({ role: 'user', content: turn.user })
      for (let round = 0; round < harness.MAX_MODEL_ROUNDS_PER_TURN; round += 1) {
        const message = await completeWithTimeout(model, { messages, tools }, requestTimeoutMs)
        const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
        if (!toolCalls.length) {
          const content = String(message.content || '').trim()
          if (content) assistantMessages.push(content)
          messages.push({ role: 'assistant', content: content || '好的' })
          break
        }
        messages.push({
          role: 'assistant',
          content: message.content || null,
          tool_calls: toolCalls,
        })
        for (const toolCall of toolCalls) {
          const name = String(toolCall?.function?.name || '')
          const args = harness.parseToolArguments(toolCall)
          const output = await harness.executeBenchmarkTool({
            service,
            cockpitId,
            calls,
            turnIndex,
            name,
            args,
          })
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: output.content || '座舱操作已完成',
          })
        }
        if (round === harness.MAX_MODEL_ROUNDS_PER_TURN - 1) {
          assistantMessages.push('模型在本轮超过最大工具调用轮数')
        }
      }
    }
  } catch (error) {
    assistantMessages.push(`BENCHMARK_ERROR: ${error.message || String(error)}`)
    return {
      id: caseItem.id,
      calls,
      assistant_messages: assistantMessages,
      error: {
        message: error.message || String(error),
      },
      final_state: service.snapshot(cockpitId),
    }
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
  const harness = await import('./controlled-harness.mjs')
  const { COCKPIT_SURFACE_ROUTING } = await import('../../service/tools/registry.mjs')
  const args = harness.parseRunnerArgs(process.argv.slice(2))
  const limit = Number(args.get('limit') || 0)
  const caseId = args.get('case-id')
  const requestTimeoutMs = harness.numberArg(args, 'request-timeout-ms', DEFAULT_REQUEST_TIMEOUT_MS)
  const domains = args.get('domain')
    ? String(args.get('domain')).split(',').map(item => item.trim()).filter(Boolean)
    : harness.BENCHMARK_DOMAINS
  const outPath = args.get('out')
    || 'examples/smart-cockpit/bench/reports/cockpit-text-latest.json'
  const model = new DashScopeCockpitModel({
    model: args.get('model') || process.env.DASHSCOPE_MODEL,
  })
  let cases = routeCasesExpectedPaths(loadBenchmarkCases({ domains }), COCKPIT_SURFACE_ROUTING)
  if (caseId) cases = cases.filter(item => item.id === caseId)
  if (limit > 0) cases = cases.slice(0, limit)
  if (!cases.length) throw new Error('No benchmark cases selected')

  const traces = []
  for (const [index, caseItem] of cases.entries()) {
    process.stderr.write(`[${index + 1}/${cases.length}] ${caseItem.id}\n`)
    traces.push(await runCase(caseItem, {
      model,
      harness,
      domains,
      requestTimeoutMs,
    }))
  }
  const scores = cases.map((caseItem, index) => scoreTrace(caseItem, traces[index]))
  const report = {
    suite: 'smart-cockpit/cockpit',
    mode: 'text',
    domains,
    model: model.model,
    request_timeout_ms: requestTimeoutMs,
    routing: COCKPIT_SURFACE_ROUTING.domains,
    created_at: new Date().toISOString(),
    summary: summarizeScores(scores),
    scores,
    traces,
  }

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
