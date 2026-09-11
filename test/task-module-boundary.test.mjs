import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

test('importing TaskManager does not initialize user configuration or durable state', t => {
  const directory = mkdtempSync(join(tmpdir(), 'qwaudio-task-import-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const configDirectory = join(directory, 'not-created')
  const entry = pathToFileURL(resolve(import.meta.dirname, '../server/src/task/task-manager.mjs')).href
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval',
    `const { TaskManager } = await import(${JSON.stringify(entry)}); new TaskManager()`,
  ], {
    env: { ...process.env, QWAUDIO_CONFIG_DIR: configDirectory }, encoding: 'utf8',
  })
  assert.equal(child.status, 0, child.stderr)
  assert.equal(existsSync(configDirectory), false)
})

test('the CLI doctor entry point does not create user configuration or logs', t => {
  const directory = mkdtempSync(join(tmpdir(), 'qwaudio-doctor-import-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const configDirectory = join(directory, 'not-created')
  const child = spawnSync(process.execPath, [resolve(import.meta.dirname, '../cli/bin/qwenaudio.mjs'),
    'doctor', '--url', 'http://127.0.0.1:1', '--json',
  ], {
    env: { ...process.env, QWAUDIO_CONFIG_DIR: configDirectory, AGENT_PROTOCOL: 'none', QWEN_AUDIO_LOG_FILE: '1' },
    encoding: 'utf8', timeout: 10_000,
  })
  assert.equal(child.status, 1, child.stderr)
  assert.equal(JSON.parse(child.stdout).schema, 'qwaudio.diagnostics/v1')
  assert.equal(existsSync(configDirectory), false)
})
