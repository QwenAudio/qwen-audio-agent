#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { arch } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const nativeRoot = resolve(root, 'desktop/native')

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: 'pipe',
  })
  if (result.error) {
    process.stderr.write(`${command}: ${result.error.message}\n`)
    process.exit(2)
  }
  const output = `${result.stdout || ''}${result.stderr || ''}`
  if (result.status !== 0 || output.includes('** TEST FAILED **')) {
    process.stderr.write(output)
    process.exit(result.status || 1)
  }
  if (result.stderr) process.stderr.write(result.stderr)
}

run('xcodegen', [
  'generate',
  '--spec', resolve(nativeRoot, 'project.yml'),
  '--project', nativeRoot,
  '--quiet',
])
run('xcodebuild', [
  '-project', resolve(nativeRoot, 'QwenInput.xcodeproj'),
  '-scheme', 'QwenInputCoreTests',
  '-configuration', 'Debug',
  '-destination', `platform=macOS,arch=${arch() === 'arm64' ? 'arm64' : 'x86_64'}`,
  'CODE_SIGN_STYLE=Manual',
  'CODE_SIGN_IDENTITY=-',
  'DEVELOPMENT_TEAM=',
  '-quiet',
  'test',
])
