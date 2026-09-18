export const modes = ['realtime-only', 'harness', 'max-only']

export function buildPlan(domains) {
  const cases = []
  // Interleave domains so a partially completed run is not retail-only.
  const length = Math.max(...Object.values(domains).map(tasks => tasks.length))
  for (let i = 0; i < length; i += 1) {
    for (const [domain, tasks] of Object.entries(domains)) {
      if (tasks[i]) cases.push({ domain, taskId: String(tasks[i].id) })
    }
  }
  return modes.flatMap(mode => cases.map(entry => ({ ...entry, mode, status: 'pending' })))
}

export function summarize(jobs) {
  return modes.flatMap(mode => ['retail', 'airline'].map(domain => {
    const group = jobs.filter(job => job.mode === mode && job.domain === domain)
    const completed = group.filter(job => job.status === 'completed')
    const passed = completed.filter(job => job.reward === 1).length
    return { mode, domain, total: group.length, completed: completed.length, passed,
      failed: completed.length - passed,
      successRate: completed.length === group.length && group.length ? passed / group.length : null,
      infrastructureFailures: completed.filter(job => job.failure || job.scoringFailure).length }
  }))
}
