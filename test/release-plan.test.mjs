import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { createReleasePlan, resolveReleaseRevision } from '../scripts/release-plan.mjs'

test('release source is immutable across first publication and manual recovery', () => {
  const headRevision = 'a'.repeat(40)
  const tagRevision = 'b'.repeat(40)
  assert.equal(resolveReleaseRevision({ headRevision }), headRevision)
  assert.equal(resolveReleaseRevision({ headRevision, tagRevision: headRevision }), headRevision)
  assert.equal(resolveReleaseRevision({ headRevision, tagRevision, manual: true }), tagRevision)
  assert.throws(() => resolveReleaseRevision({ headRevision, tagRevision }), /does not match/)
  assert.throws(() => resolveReleaseRevision({ headRevision: 'main' }), /full commit SHA/)
})

test('release verification and every package builder use the planned SHA, never a mutable ref', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'))
  for (const job of ['verify', 'macos', 'windows', 'npm']) {
    const checkout = workflow.jobs[job].steps.find(step => step.uses?.startsWith('actions/checkout@'))
    assert.equal(checkout.with.ref, '${{ needs.plan.outputs.revision }}', job)
  }
  const tag = workflow.jobs.tag.steps.find(step => step.env?.RELEASE_TAG)
  assert.equal(tag.env.RELEASE_REVISION, '${{ needs.plan.outputs.revision }}')
  assert.match(tag.run, /\$RESOLVED.*!=.*\$RELEASE_REVISION/)
  assert.doesNotMatch(tag.run, /sha=\$\{GITHUB_SHA\}/)
})

test('skips ordinary main updates when the package version is unchanged', () => {
  assert.deepEqual(createReleasePlan({
    currentVersion: '0.10.0',
    previousVersion: '0.10.0',
    changelog: '# Changelog\n\n## 0.10.0\n',
  }), {
    release: false,
    version: '0.10.0',
    tag: 'v0.10.0',
    previousVersion: '0.10.0',
    manual: false,
  })
})

test('plans a release when a release PR changes the package version', () => {
  assert.deepEqual(createReleasePlan({
    currentVersion: '0.11.0',
    previousVersion: '0.10.0',
    changelog: '# Changelog\n\n## 0.11.0\n',
  }), {
    release: true,
    version: '0.11.0',
    tag: 'v0.11.0',
    previousVersion: '0.10.0',
    manual: false,
  })
})

test('supports an explicit recovery run for the current version', () => {
  const plan = createReleasePlan({
    currentVersion: '0.10.0',
    requestedVersion: '0.10.0',
    changelog: '# Changelog\n\n## 0.10.0\n',
  })
  assert.equal(plan.release, true)
  assert.equal(plan.manual, true)
  assert.equal(plan.tag, 'v0.10.0')
})

test('rejects mismatched recovery versions and missing changelog entries', () => {
  assert.throws(() => createReleasePlan({
    currentVersion: '0.10.0',
    requestedVersion: '0.9.1',
    changelog: '# Changelog\n\n## 0.10.0\n',
  }), /不一致/)
  assert.throws(() => createReleasePlan({
    currentVersion: '0.11.0',
    previousVersion: '0.10.0',
    changelog: '# Changelog\n\n## 0.10.0\n',
  }), /CHANGELOG/)
})
