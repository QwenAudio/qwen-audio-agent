import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FRONTEND_EVALUATION_CASES,
  runFrontendRuntimeEvaluations,
} from '../eval/frontend-runtime-evaluations.mjs'

test('passes every deterministic frontend runtime evaluation', async () => {
  const report = await runFrontendRuntimeEvaluations()
  assert.equal(report.passed, true, JSON.stringify(report.results, null, 2))
  assert.equal(report.summary.failed, 0)
  assert.deepEqual(
    new Set(report.results.map(result => result.dimension)),
    new Set([
      'routing',
      'citation',
      'interruption',
      'duplicate-speech',
      'prompt-injection',
    ]),
  )
})

test('reports a failing evaluation without aborting the suite', async () => {
  const report = await runFrontendRuntimeEvaluations({
    cases: [
      FRONTEND_EVALUATION_CASES[0],
      {
        id: 'negative-control',
        dimension: 'control',
        run: async () => { throw new Error('expected failure') },
      },
    ],
  })
  assert.equal(report.passed, false)
  assert.deepEqual(report.summary, { total: 2, passed: 1, failed: 1 })
  assert.equal(report.results[1].error, 'expected failure')
})
