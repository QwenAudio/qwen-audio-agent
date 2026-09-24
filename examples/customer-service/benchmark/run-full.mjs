import { spawn, execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, renameSync, mkdirSync, createWriteStream, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { buildPlan, modes, parseConcurrency, parseTimeoutRetries,
  parseHarnessTurnTimeoutSeconds, isTimeoutAttempt, runWithTimeoutRetry, summarize } from './full-plan.mjs'

const root = process.env.CS_TAU2_ROOT
if (!root || !process.env.CS_TAU2_PYTHON) throw new Error('Set CS_TAU2_ROOT and CS_TAU2_PYTHON')
const selectedModes = process.env.CS_TAU_MODES
  ? process.env.CS_TAU_MODES.split(',').map(mode => mode.trim()).filter(Boolean)
  : modes
if (!selectedModes.length || new Set(selectedModes).size !== selectedModes.length
  || selectedModes.some(mode => !modes.includes(mode))) {
  throw new Error(`CS_TAU_MODES must be a comma-separated subset of ${modes.join(', ')}`)
}
const concurrency = parseConcurrency(process.env.CS_TAU_CONCURRENCY)
const timeoutRetries = parseTimeoutRetries(process.env.CS_TAU_TIMEOUT_RETRIES)
const harnessTurnTimeoutSeconds = parseHarnessTurnTimeoutSeconds(process.env.CS_TAU_HARNESS_TURN_TIMEOUT_SECONDS)
const output = resolve(process.env.CS_TAU_OUTPUT_DIR || 'examples/customer-service/.runtime/tau-full')
mkdirSync(output, { recursive: true })
const manifestPath = resolve(output, 'manifest.json')
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const allDomains = Object.fromEntries(['retail', 'airline'].map(domain => [domain,
  JSON.parse(readFileSync(resolve(root, `data/tau2/domains/${domain}/tasks.json`), 'utf8'))]))
const selectedCases = process.env.CS_TAU_CASES
  ? process.env.CS_TAU_CASES.split(',').map(entry => entry.trim()).filter(Boolean)
  : null
if (selectedCases && (!selectedCases.length || new Set(selectedCases).size !== selectedCases.length
  || selectedCases.some(entry => {
    const [domain, id, extra] = entry.split(':')
    return extra !== undefined || !allDomains[domain]?.some(task => String(task.id) === id)
  }))) throw new Error('CS_TAU_CASES must list distinct existing domain:taskId entries')
const domains = selectedCases
  ? Object.fromEntries(Object.entries(allDomains).map(([domain, tasks]) => [domain,
      tasks.filter(task => selectedCases.includes(`${domain}:${task.id}`))]))
  : allDomains
const signature = createHash('sha256').update(git('diff', 'HEAD')).update(
  ['run-full.mjs', 'full-plan.mjs', 'max-only.mjs', 'tau-worker.py', 'run-harness.mjs']
    .map(name => readFileSync(new URL(name, import.meta.url))).join('\n')).digest('hex')
const configuration = { agentCommit: git('rev-parse', 'HEAD'), sourceSignature: signature,
  tauCommit: git('-C', root, 'rev-parse', 'HEAD'),
  modes: selectedModes, cases: selectedCases,
  harnessPromptVariant: process.env.CS_TAU_HARNESS_PROMPT_VARIANT || 'compact',
  concurrency, timeoutRetries, harnessTurnTimeoutSeconds,
  backendModel: process.env.CS_TAU_BACKEND_MODEL || 'qwen3.8-max',
  userModel: process.env.CS_TAU_USER_MODEL || 'qwen3.8-flash',
  judgeModel: process.env.CS_TAU_JUDGE_MODEL || 'qwen3.8-flash',
  userApiBase: process.env.CS_TAU_USER_API_BASE || process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  judgeApiBase: process.env.CS_TAU_JUDGE_API_BASE || process.env.CS_TAU_USER_API_BASE || process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  userApiKeyEnv: process.env.CS_TAU_USER_API_KEY_ENV || 'DASHSCOPE_API_KEY',
  judgeApiKeyEnv: process.env.CS_TAU_JUDGE_API_KEY_ENV || process.env.CS_TAU_USER_API_KEY_ENV || 'DASHSCOPE_API_KEY',
  trialsPerTask: 1, timeoutSeconds: 300,
  scope: selectedCases ? 'Selected retail/airline tasks; text-only adapted tau2 evaluation, not native leaderboard settings'
    : 'All base retail/airline tasks; text-only adapted tau2 evaluation, not native leaderboard settings' }
let manifest
try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) }
catch (error) { if (error.code !== 'ENOENT') throw error }
if (manifest && JSON.stringify(manifest.configuration) !== JSON.stringify(configuration)) {
  throw new Error('Configuration/source changed: use a new output directory')
}
manifest ||= { configuration, startedAt: new Date().toISOString(), jobs: buildPlan(domains, selectedModes) }
const save = () => {
  manifest.updatedAt = new Date().toISOString()
  manifest.summary = summarize(manifest.jobs, selectedModes)
  writeFileSync(`${manifestPath}.tmp`, JSON.stringify(manifest, null, 2))
  renameSync(`${manifestPath}.tmp`, manifestPath)
}
function finishAttempt(attempt, path) {
  const result = JSON.parse(readFileSync(path, 'utf8'))
  Object.assign(attempt, { status: 'completed', path, reward: result.reward?.reward ?? 0,
    failure: result.failure, scoringFailure: result.scoringFailure,
    terminationReason: result.terminationReason, replayMatchesLive: result.replayMatchesLive })
}
function attemptFiles(job, index) {
  const prefix = `${job.mode}-${job.domain}-${job.taskId}-attempt${index}-`
  return readdirSync(output).filter(name => name.startsWith(prefix) && name.endsWith('.json'))
}
function settleJob(job) {
  const [primary, retry] = job.attempts
  Object.assign(job, { status: 'completed', path: primary.path, reward: primary.reward,
    failure: primary.failure, scoringFailure: primary.scoringFailure,
    replayMatchesLive: primary.replayMatchesLive,
    retry: retry ? { path: retry.path, reward: retry.reward, failure: retry.failure,
      scoringFailure: retry.scoringFailure, terminationReason: retry.terminationReason,
      replayMatchesLive: retry.replayMatchesLive } : undefined,
    finishedAt: new Date().toISOString() })
}
// Recover completed artifacts, but never silently rerun an interrupted attempt.
for (const job of manifest.jobs.filter(job => job.status === 'running')) {
  job.attempts ||= []
  for (const [index, attempt] of job.attempts.entries()) {
    if (attempt.status !== 'running') continue
    const existing = attemptFiles(job, index + 1)
    if (existing.length === 1) finishAttempt(attempt, resolve(output, existing[0]))
    else Object.assign(attempt, { status: 'completed', reward: 0,
      failure: 'Runner interrupted without a unique result; retained in denominator' })
  }
  if (!job.attempts.length || (job.attempts.length === 1
    && timeoutRetries && isTimeoutAttempt(job.attempts[0]))) job.status = 'pending'
  else settleJob(job)
}
save()
const runner = fileURLToPath(new URL('./run-harness.mjs', import.meta.url))
async function runAttempt(job, index) {
  const attempt = { status: 'running', startedAt: new Date().toISOString() }
  job.attempts.push(attempt); save()
  const log = createWriteStream(resolve(output, `${job.mode}-${job.domain}-${job.taskId}-attempt${index}.log`), { flags: 'a' })
  const child = spawn(process.execPath, [runner, `${job.domain}:${job.taskId}`], {
    env: { ...process.env, CS_TAU_MODE: job.mode, CS_TAU_OUTPUT_DIR: output,
      CS_TAU_ATTEMPT: String(index), CS_TAU_HARNESS_TURN_TIMEOUT_SECONDS: String(harnessTurnTimeoutSeconds) },
    stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false })
  let buffer = '', resultPath
  child.stdout.on('data', data => {
    buffer += data.toString()
    const lines = buffer.split('\n'); buffer = lines.pop()
    for (const line of lines) {
      try { const parsed = JSON.parse(line); if (parsed.path) resultPath = parsed.path } catch {}
    }
  })
  const timeout = setTimeout(() => child.kill('SIGTERM'), 450_000)
  const kill = setTimeout(() => child.kill('SIGKILL'), 460_000)
  const outcome = await new Promise(resolveExit => {
    child.once('error', error => resolveExit(error.message))
    child.once('close', (code, signal) => resolveExit(`exit=${code}, signal=${signal}`))
  })
  clearTimeout(timeout); clearTimeout(kill); log.end()
  const existing = attemptFiles(job, index)
  if (resultPath) finishAttempt(attempt, resultPath)
  else if (existing.length === 1) finishAttempt(attempt, resolve(output, existing[0]))
  else Object.assign(attempt, { status: 'completed', reward: 0, failure: `No result: ${outcome}` })
  attempt.finishedAt = new Date().toISOString(); save()
}
async function run(job) {
  job.status = 'running'; job.startedAt ||= new Date().toISOString(); job.attempts ||= []; save()
  await runWithTimeoutRetry(job, runAttempt, timeoutRetries)
  settleJob(job); save()
  console.log(JSON.stringify({ mode: job.mode, domain: job.domain, taskId: job.taskId,
    reward: job.reward, failure: job.failure, retryReward: job.retry?.reward,
    retryFailure: job.retry?.failure, completed: manifest.jobs.filter(j => j.status === 'completed').length,
    total: manifest.jobs.length }))
}
// Claim each pending job once. The plan interleaves domains; a bounded pool
// avoids model/API overload while letting slow user simulations overlap.
const pending = manifest.jobs.filter(job => selectedModes.includes(job.mode) && job.status === 'pending')
let next = 0
await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
  while (next < pending.length) await run(pending[next++])
}))
manifest.finishedAt = new Date().toISOString(); save()
console.log(JSON.stringify(manifest.summary, null, 2))
