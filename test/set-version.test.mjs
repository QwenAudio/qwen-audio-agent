import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  isValidVersion,
  nextVersion,
  updateVersions,
} from '../scripts/set-version.mjs'

const WORKSPACES = ['server', 'web', 'tui', 'desktop', 'cli']

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'qwen-audio-version-'))
  writeJson(join(root, 'package.json'), {
    name: 'qwen-audio-agent',
    version: '0.5.0',
  })
  const packages = {
    '': { name: 'qwen-audio-agent', version: '0.5.0' },
  }
  for (const workspace of WORKSPACES) {
    mkdirSync(join(root, workspace))
    writeJson(join(root, workspace, 'package.json'), {
      name: `@qwen-audio-agent/${workspace}`,
      version: '0.5.0',
    })
    packages[workspace] = {
      name: `@qwen-audio-agent/${workspace}`,
      version: '0.5.0',
    }
  }
  writeJson(join(root, 'package-lock.json'), {
    name: 'qwen-audio-agent',
    version: '0.5.0',
    lockfileVersion: 3,
    packages,
  })
  for (const file of ['README.md', 'README_ZH.md']) {
    writeFileSync(
      join(root, file),
      '[![npm](https://img.shields.io/badge/npm-v0.5.0-orange)](https://npmjs.com)\n',
    )
  }
  return root
}

test('validates release and prerelease versions', () => {
  assert.equal(isValidVersion('0.5.1'), true)
  assert.equal(isValidVersion('0.6.0-beta.1'), true)
  assert.equal(isValidVersion('01.2.3'), false)
  assert.equal(isValidVersion('0.5'), false)
})

test('increments semantic versions from the root version', () => {
  assert.equal(nextVersion('0.5.0', 'patch'), '0.5.1')
  assert.equal(nextVersion('0.5.0', 'minor'), '0.6.0')
  assert.equal(nextVersion('0.5.0', 'major'), '1.0.0')
  assert.equal(nextVersion('0.5.0', '0.6.0-beta.1'), '0.6.0-beta.1')
  assert.throws(() => nextVersion('0.5.0', 'latest'), /完整版本号/)
})

test('updates every manifest and package-lock workspace together', () => {
  const root = fixture()
  const result = updateVersions(root, 'minor')
  assert.deepEqual(result, {
    previousVersion: '0.5.0',
    version: '0.6.0',
    changed: true,
  })
  for (const relativePath of [
    'package.json',
    ...WORKSPACES.map(workspace => `${workspace}/package.json`),
  ]) {
    const manifest = JSON.parse(readFileSync(join(root, relativePath), 'utf8'))
    assert.equal(manifest.version, '0.6.0')
  }
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
  assert.equal(lock.version, '0.6.0')
  assert.equal(lock.packages[''].version, '0.6.0')
  for (const workspace of WORKSPACES) {
    assert.equal(lock.packages[workspace].version, '0.6.0')
  }
  for (const file of ['README.md', 'README_ZH.md']) {
    assert.match(
      readFileSync(join(root, file), 'utf8'),
      /img\.shields\.io\/badge\/npm-v0\.6\.0-orange/,
    )
  }
})
