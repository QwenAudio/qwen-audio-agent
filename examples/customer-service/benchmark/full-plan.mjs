export const modes = ['realtime-only', 'harness', 'max-only']

export function parseDomains(value, availableDomains) {
  const available = [...availableDomains]
  if (value === undefined) return available
  const selected = value.split(',').map(domain => domain.trim()).filter(Boolean)
  if (!selected.length || new Set(selected).size !== selected.length
    || selected.some(domain => !available.includes(domain))) {
    throw new Error(`CS_TAU_DOMAINS must be a comma-separated subset of ${available.join(', ')}`)
  }
  return selected
}

export function parseConcurrency(value) {
  const concurrency = value === undefined ? 1 : Number(value)
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new Error('CS_TAU_CONCURRENCY must be an integer between 1 and 8')
  }
  return concurrency
}

export function parseTimeoutRetries(value) {
  const retries = value === undefined ? 1 : Number(value)
  if (value === '' || !Number.isSafeInteger(retries) || retries < 0 || retries > 1) {
    throw new Error('CS_TAU_TIMEOUT_RETRIES must be 0 or 1')
  }
  return retries
}

export function parseHarnessTurnTimeoutSeconds(value) {
  const seconds = value === undefined ? 180 : Number(value)
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 300) {
    throw new Error('CS_TAU_HARNESS_TURN_TIMEOUT_SECONDS must be an integer from 1 to 300')
  }
  return seconds
}

export function isTimeoutAttempt(attempt) {
  if (!attempt || attempt.status !== 'completed') return false
  return attempt.terminationReason === 'timeout'
    || /(?:timed out|timeout)/iu.test([attempt.failure, attempt.scoringFailure].filter(Boolean).join(' '))
    || /^No result: .*signal=SIG(?:TERM|KILL)$/u.test(attempt.failure || '')
}

export async function runWithTimeoutRetry(job, runAttempt, retries = 1) {
  if (!job.attempts.length) await runAttempt(job, 1)
  if (retries && job.attempts.length === 1 && isTimeoutAttempt(job.attempts[0])) {
    await runAttempt(job, 2)
  }
}

export function buildPlan(domains, selectedModes = modes) {
  const cases = []
  // Interleave domains so a partially completed run is not retail-only.
  const length = Math.max(...Object.values(domains).map(tasks => tasks.length))
  for (let i = 0; i < length; i += 1) {
    for (const [domain, tasks] of Object.entries(domains)) {
      if (tasks[i]) cases.push({ domain, taskId: String(tasks[i].id) })
    }
  }
  return selectedModes.flatMap(mode => cases.map(entry => ({ ...entry, mode, status: 'pending' })))
}

export function summarize(jobs, selectedModes = modes) {
  const domains = [...new Set(jobs.map(job => job.domain))]
  return selectedModes.flatMap(mode => domains.map(domain => {
    const group = jobs.filter(job => job.mode === mode && job.domain === domain)
    const completed = group.filter(job => job.status === 'completed')
    const passed = completed.filter(job => job.reward === 1).length
    const retried = completed.filter(job => job.attempts?.length === 2)
    const retryRecovered = retried.filter(job => job.attempts[0].reward !== 1 && job.attempts[1].reward === 1).length
    return { mode, domain, total: group.length, completed: completed.length, passed,
      failed: completed.length - passed,
      successRate: completed.length === group.length && group.length ? passed / group.length : null,
      infrastructureFailures: completed.filter(job => job.failure || job.scoringFailure).length,
      retried: retried.length, retryRecovered,
      retryAdjustedPassed: passed + retryRecovered,
      retryAdjustedSuccessRate: completed.length === group.length && group.length
        ? (passed + retryRecovered) / group.length : null }
  }))
}
