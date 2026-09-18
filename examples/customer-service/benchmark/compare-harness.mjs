import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(process.argv[2] || 'examples/customer-service/.runtime/tau-harness-comparison')
for (const mode of ['realtime-only', 'harness']) {
  const directory = resolve(mode === 'harness' && process.argv[3] ? process.argv[3] : root, mode)
  if (!existsSync(directory)) continue
  const results = readdirSync(directory).filter(path => path.endsWith('.json'))
    .map(path => JSON.parse(readFileSync(resolve(directory, path), 'utf8')))
  for (const domain of ['retail', 'airline']) {
    const cases = results.filter(result => result.domain === domain)
      .sort((a, b) => Number(a.taskId) - Number(b.taskId))
    const ids = new Set()
    for (const item of cases) {
      if (ids.has(item.taskId)) throw new Error(`Duplicate trial: ${mode}/${domain}/${item.taskId}`)
      ids.add(item.taskId)
    }
    const succeeded = cases.filter(result => result.reward?.reward === 1 && !result.failure
      && !result.scoringFailure && result.replayMatchesLive === true).length
    console.log(JSON.stringify({ mode, domain, completed: cases.length, succeeded,
      passRateAmongCompleted: cases.length ? succeeded / cases.length : null,
      executionErrors: cases.filter(result => result.failure).length,
      scoringErrors: cases.filter(result => result.scoringFailure || !result.reward || result.replayMatchesLive !== true).length,
      cases: cases.map(result => ({ id: result.taskId, reward: result.reward?.reward,
        failure: result.failure, failureStage: result.failureStage, scoringFailure: result.scoringFailure,
        termination: result.terminationReason, replayMatchesLive: result.replayMatchesLive,
        backendTasks: result.backendTasks, failedBackendTasks: result.failedBackendTasks,
        realtimeResponses: result.realtimeResponses, backendModelCalls: result.backendModelCalls,
        toolCalls: result.executedToolCalls, userTurns: result.userTurns, seconds: result.durationSeconds,
      })),
    }))
  }
}
