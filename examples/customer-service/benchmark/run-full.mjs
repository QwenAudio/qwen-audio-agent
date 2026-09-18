import { spawn, execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, renameSync, mkdirSync, createWriteStream, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { buildPlan, modes, summarize } from './full-plan.mjs'

const root = process.env.CS_TAU2_ROOT
if (!root || !process.env.CS_TAU2_PYTHON) throw new Error('Set CS_TAU2_ROOT and CS_TAU2_PYTHON')
const output = resolve(process.env.CS_TAU_OUTPUT_DIR || 'examples/customer-service/.runtime/tau-full')
mkdirSync(output, { recursive: true })
const manifestPath = resolve(output, 'manifest.json')
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const domains = Object.fromEntries(['retail', 'airline'].map(domain => [domain,
  JSON.parse(readFileSync(resolve(root, `data/tau2/domains/${domain}/tasks.json`), 'utf8'))]))
const signature = createHash('sha256').update(git('diff', 'HEAD')).update(
  ['run-full.mjs', 'full-plan.mjs', 'max-only.mjs', 'tau-worker.py', 'run-harness.mjs']
    .map(name => readFileSync(new URL(name, import.meta.url))).join('\n')).digest('hex')
const configuration = { agentCommit: git('rev-parse', 'HEAD'), sourceSignature: signature,
  tauCommit: git('-C', root, 'rev-parse', 'HEAD'),
  backendModel: process.env.CS_TAU_BACKEND_MODEL || 'qwen3.8-max',
  userModel: process.env.CS_TAU_USER_MODEL || 'qwen3.8-flash',
  judgeModel: process.env.CS_TAU_JUDGE_MODEL || 'qwen3.8-flash',
  trialsPerTask: 1, maxUserTurns: 16, timeoutSeconds: 300,
  scope: 'All base retail/airline tasks; text-only adapted tau2 evaluation, not native leaderboard settings' }
let manifest
try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) }
catch (error) { if (error.code !== 'ENOENT') throw error }
if (manifest && JSON.stringify(manifest.configuration) !== JSON.stringify(configuration)) {
  throw new Error('Configuration/source changed: use a new output directory')
}
manifest ||= { configuration, startedAt: new Date().toISOString(), jobs: buildPlan(domains) }
const save = () => {
  manifest.updatedAt = new Date().toISOString()
  manifest.summary = summarize(manifest.jobs)
  writeFileSync(`${manifestPath}.tmp`, JSON.stringify(manifest, null, 2))
  renameSync(`${manifestPath}.tmp`, manifestPath)
}
function finish(job, path) {
  const result = JSON.parse(readFileSync(path, 'utf8'))
  Object.assign(job, { status: 'completed', path, reward: result.reward?.reward ?? 0,
    failure: result.failure, scoringFailure: result.scoringFailure,
    replayMatchesLive: result.replayMatchesLive })
}
// Never rerun a finished result or silently select the best of several trials.
for (const job of manifest.jobs.filter(job => job.status === 'running')) {
  const existing = readdirSync(output).filter(name => name.startsWith(`${job.mode}-${job.domain}-${job.taskId}-`) && name.endsWith('.json'))
  if (existing.length === 1) finish(job, resolve(output, existing[0]))
  else Object.assign(job, { status: 'completed', reward: 0, failure: 'Runner interrupted without a unique result; retained in denominator' })
}
save()
const runner = fileURLToPath(new URL('./run-harness.mjs', import.meta.url))
async function run(job) {
  job.status = 'running'; job.startedAt = new Date().toISOString(); save()
  const log = createWriteStream(resolve(output, `${job.mode}-${job.domain}-${job.taskId}.log`), { flags: 'a' })
  const child = spawn(process.execPath, [runner, `${job.domain}:${job.taskId}`], {
    env: { ...process.env, CS_TAU_MODE: job.mode, CS_TAU_OUTPUT_DIR: output }, stdio: ['ignore', 'pipe', 'pipe'] })
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
  if (resultPath) finish(job, resultPath)
  else Object.assign(job, { status: 'completed', reward: 0, failure: `No result: ${outcome}` })
  job.finishedAt = new Date().toISOString(); save()
  console.log(JSON.stringify({ mode: job.mode, domain: job.domain, taskId: job.taskId,
    reward: job.reward, failure: job.failure, completed: manifest.jobs.filter(j => j.status === 'completed').length,
    total: manifest.jobs.length }))
}
// One serial queue per group: three concurrent cases total, never hundreds of calls at once.
await Promise.all(modes.map(async mode => {
  for (const job of manifest.jobs.filter(job => job.mode === mode && job.status === 'pending')) await run(job)
}))
manifest.finishedAt = new Date().toISOString(); save()
console.log(JSON.stringify(manifest.summary, null, 2))
