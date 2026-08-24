#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const desktopRoot = join(root, 'desktop')
const testRoot = join(desktopRoot, 'test')
const serialNativeTests = [
  'native-input-build.test.mjs',
  'native-input-process.test.mjs',
  'native-input-xpc.test.mjs',
]
const serialNativeSet = new Set(serialNativeTests)
const ordinaryTests = readdirSync(testRoot)
  .filter(name => name.endsWith('.test.mjs') && !serialNativeSet.has(name))
  .sort()

run(ordinaryTests)
for (const testFile of serialNativeTests) run([testFile])

function run(testFiles) {
  const result = spawnSync(process.execPath, [
    '--test',
    ...testFiles.map(file => join(testRoot, file)),
  ], {
    cwd: desktopRoot,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
