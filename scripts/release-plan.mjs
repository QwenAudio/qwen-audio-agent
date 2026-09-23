#!/usr/bin/env node

import { appendFileSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isValidVersion } from './set-version.mjs'

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function changelogHasVersion(changelog, version) {
  return String(changelog)
    .split(/\r?\n/)
    .some(line => line.trim() === `## ${version}`)
}

export function resolveReleaseRevision({ headRevision, tagRevision = '', manual = false }) {
  for (const revision of [headRevision, tagRevision].filter(Boolean)) {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision)) {
      throw new Error('Release revision must be a full commit SHA')
    }
  }
  if (!headRevision) throw new Error('Release HEAD is required')
  if (tagRevision && tagRevision !== headRevision && !manual) {
    throw new Error('Release tag does not match the triggering commit')
  }
  return tagRevision || headRevision
}

export function createReleasePlan({
  currentVersion,
  previousVersion = '',
  requestedVersion = '',
  changelog = '',
}) {
  if (!isValidVersion(currentVersion)) {
    throw new Error(`当前发布版本无效：${currentVersion}`)
  }
  if (requestedVersion && requestedVersion !== currentVersion) {
    throw new Error(
      `手动请求版本 ${requestedVersion} 与 package.json ${currentVersion} 不一致`,
    )
  }
  if (previousVersion && !isValidVersion(previousVersion)) {
    throw new Error(`合并前版本无效：${previousVersion}`)
  }

  const release = Boolean(requestedVersion)
    || Boolean(previousVersion && previousVersion !== currentVersion)
  if (release && !changelogHasVersion(changelog, currentVersion)) {
    throw new Error(`CHANGELOG.md 缺少 ## ${currentVersion}`)
  }

  return {
    release,
    version: currentVersion,
    tag: `v${currentVersion}`,
    previousVersion,
    manual: Boolean(requestedVersion),
  }
}

function versionAtRevision(root, revision) {
  if (!revision || /^0+$/.test(revision)) return ''
  const content = execFileSync(
    'git',
    ['show', `${revision}:package.json`],
    { cwd: root, encoding: 'utf8' },
  )
  return JSON.parse(content).version
}

function writeOutputs(path, plan) {
  if (!path) return
  appendFileSync(path, [
    `release=${plan.release}`,
    `version=${plan.version}`,
    `tag=${plan.tag}`,
    `previous_version=${plan.previousVersion}`,
    `manual=${plan.manual}`,
    `revision=${plan.revision || ''}`,
    '',
  ].join('\n'))
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  try {
    const manifest = JSON.parse(
      readFileSync(resolve(SCRIPT_ROOT, 'package.json'), 'utf8'),
    )
    const requestedVersion = String(
      process.env.RELEASE_REQUESTED_VERSION || '',
    ).trim()
    const previousVersion = requestedVersion
      ? ''
      : versionAtRevision(
          SCRIPT_ROOT,
          String(process.env.RELEASE_BEFORE_SHA || '').trim(),
        )
    const plan = createReleasePlan({
      currentVersion: manifest.version,
      previousVersion,
      requestedVersion,
      changelog: readFileSync(
        resolve(SCRIPT_ROOT, 'CHANGELOG.md'),
        'utf8',
      ),
    })
    if (plan.release) {
      const git = args => execFileSync('git', args, { cwd: SCRIPT_ROOT, encoding: 'utf8' }).trim()
      let tagRevision = ''
      try { tagRevision = git(['rev-parse', '--verify', '--quiet', `refs/tags/${plan.tag}^{commit}`]) } catch (error) {
        if (error.status !== 1) throw error
      }
      plan.revision = resolveReleaseRevision({
        headRevision: git(['rev-parse', 'HEAD']), tagRevision, manual: plan.manual,
      })
      // Recovery verifies the immutable tagged source, not the current branch.
      if (versionAtRevision(SCRIPT_ROOT, plan.revision) !== plan.version
        || !changelogHasVersion(git(['show', `${plan.revision}:CHANGELOG.md`]), plan.version)) {
        throw new Error('Release source version or changelog does not match the requested version')
      }
    }
    writeOutputs(process.env.GITHUB_OUTPUT, plan)
    process.stdout.write(
      plan.release
        ? `准备发布 ${plan.tag}${plan.manual ? '（手动恢复）' : ''}\n`
        : `版本仍为 ${plan.version}，本次 main 更新无需发布。\n`,
    )
  } catch (error) {
    process.stderr.write(`发布计划检查失败：${error.message}\n`)
    process.exitCode = 1
  }
}
