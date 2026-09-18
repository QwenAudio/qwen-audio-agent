import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Never select the best attempt or silently drop infrastructure/scoring failures.
const root = resolve(process.argv[2])
for (const domain of ['retail', 'airline']) {
  const directory = resolve(root, domain)
  const results = readdirSync(directory).filter(name => name.endsWith('.json'))
    .map(name => JSON.parse(readFileSync(resolve(directory, name), 'utf8')))
  const ids = results.map(result => result.taskId)
  if (new Set(ids).size !== ids.length) throw new Error(`Duplicate trials in ${domain}; summarize each trial separately`)
  const scoringErrors = results.filter(result => result.scoringFailure || !result.reward || !result.replayMatchesLive)
  const passed = results.filter(result => !result.failure && !result.scoringFailure
    && result.replayMatchesLive && result.reward?.reward === 1)
  console.log(JSON.stringify({ domain, completed: results.length, passed: passed.length,
    passRateAmongCompleted: results.length ? passed.length / results.length : null,
    scoringErrors: scoringErrors.length, executionErrors: results.filter(result => result.failure).length,
    tasks: results.map(result => ({ id: result.taskId, reward: result.reward?.reward,
      termination: result.terminationReason, failure: result.failure, scoringFailure: result.scoringFailure,
      replayMatchesLive: result.replayMatchesLive, modelCalls: result.modelCalls,
      tools: result.executedToolCalls, userTurns: result.userTurns, seconds: result.durationSeconds })) }))
}
