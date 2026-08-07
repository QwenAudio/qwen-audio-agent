#!/usr/bin/env node

import {
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORKSPACES = ['server', 'web', 'tui', 'desktop', 'cli']
const MANIFESTS = [
  'package.json',
  ...WORKSPACES.map(workspace => `${workspace}/package.json`),
]
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/

export function isValidVersion(version) {
  return VERSION_PATTERN.test(String(version))
}

export function nextVersion(current, requested) {
  if (isValidVersion(requested)) return requested
  if (!['patch', 'minor', 'major'].includes(requested)) {
    throw new Error(
      '请指定完整版本号或 patch、minor、major，例如：'
      + 'npm run version:set -- 0.5.1',
    )
  }
  if (!isValidVersion(current)) {
    throw new Error(`当前版本号无效：${current}`)
  }
  const [major, minor, patch] = current
    .split('-', 1)[0]
    .split('.')
    .map(Number)
  if (requested === 'major') return `${major + 1}.0.0`
  if (requested === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

function writeAtomic(path, content) {
  const temporaryPath = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(temporaryPath, content)
    renameSync(temporaryPath, path)
  } catch (error) {
    try {
      unlinkSync(temporaryPath)
    } catch {
      // The temporary file may not have been created.
    }
    throw error
  }
}

export function updateVersions(root, requested) {
  const rootManifest = readJson(resolve(root, 'package.json'))
  const version = nextVersion(rootManifest.version, requested)
  const updates = MANIFESTS.map(relativePath => {
    const path = resolve(root, relativePath)
    const manifest = readJson(path)
    if (!manifest.name) {
      throw new Error(`${relativePath} 缺少 package name`)
    }
    manifest.version = version
    return { path, content: serializeJson(manifest) }
  })

  const lockPath = resolve(root, 'package-lock.json')
  const lock = readJson(lockPath)
  if (!lock.packages?.['']) {
    throw new Error('package-lock.json 缺少根包记录')
  }
  lock.version = version
  lock.packages[''].version = version
  for (const workspace of WORKSPACES) {
    if (!lock.packages[workspace]) {
      throw new Error(`package-lock.json 缺少 workspace：${workspace}`)
    }
    lock.packages[workspace].version = version
  }
  updates.push({ path: lockPath, content: serializeJson(lock) })

  for (const relativePath of ['README.md', 'README_ZH.md']) {
    const path = resolve(root, relativePath)
    if (!existsSync(path)) continue
    const content = readFileSync(path, 'utf8')
    const updated = content.replace(
      /img\.shields\.io\/badge\/npm-v[^-)]+-orange/g,
      `img.shields.io/badge/npm-v${version}-orange`,
    )
    updates.push({ path, content: updated })
  }

  for (const update of updates) writeAtomic(update.path, update.content)
  return {
    previousVersion: rootManifest.version,
    version,
    changed: rootManifest.version !== version,
  }
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  try {
    const result = updateVersions(SCRIPT_ROOT, process.argv[2])
    if (result.changed) {
      process.stdout.write(
        `版本已更新：${result.previousVersion} → ${result.version}\n`
        + `请更新 CHANGELOG.md，然后运行 npm run release:check。\n`,
      )
    } else {
      process.stdout.write(`版本已经是 ${result.version}。\n`)
    }
  } catch (error) {
    process.stderr.write(`版本更新失败：${error.message}\n`)
    process.exitCode = 1
  }
}
