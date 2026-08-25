import { runFrontendRuntimeEvaluations } from './frontend-runtime-evaluations.mjs'

const report = await runFrontendRuntimeEvaluations()
if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
} else {
  for (const result of report.results) {
    const mark = result.passed ? 'PASS' : 'FAIL'
    process.stdout.write(
      `${mark} ${result.dimension}: ${result.id} (${result.durationMs} ms)\n`,
    )
    if (!result.passed) process.stdout.write(`  ${result.error}\n`)
  }
  process.stdout.write(
    `Frontend evaluations: ${report.summary.passed}/${report.summary.total} passed.\n`,
  )
}
if (!report.passed) process.exitCode = 1
