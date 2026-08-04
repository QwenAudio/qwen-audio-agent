import assert from 'node:assert/strict'
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { writeFileAtomic } from '../shared/atomic-file.mjs'

test('writes a private temporary file before atomically renaming it', async () => {
  const calls = []
  const fs = {
    async writeFile(...args) {
      calls.push(['writeFile', ...args])
    },
    async rename(...args) {
      calls.push(['rename', ...args])
    },
    async rm(...args) {
      calls.push(['rm', ...args])
    },
  }

  await writeFileAtomic('/config/config.env', 'VALUE=one\n', {
    fs,
    randomSuffix: () => 'fixed',
  })

  assert.deepEqual(calls, [
    [
      'writeFile',
      '/config/config.env.tmp-fixed',
      'VALUE=one\n',
      { encoding: 'utf8', mode: 0o600 },
    ],
    [
      'rename',
      '/config/config.env.tmp-fixed',
      '/config/config.env',
    ],
  ])
})

test('cleans only its temporary path when rename fails', async () => {
  const calls = []
  const failure = new Error('rename failed')
  const fs = {
    async writeFile(...args) {
      calls.push(['writeFile', ...args])
    },
    async rename(...args) {
      calls.push(['rename', ...args])
      throw failure
    },
    async rm(...args) {
      calls.push(['rm', ...args])
    },
  }

  await assert.rejects(writeFileAtomic('/config/config.env', 'new', {
    fs,
    randomSuffix: () => 'failed',
  }), error => error === failure)

  assert.deepEqual(calls.at(-1), [
    'rm',
    '/config/config.env.tmp-failed',
    { force: true },
  ])
  assert.equal(
    calls.some(call => call[0] === 'rm' && call[1] === '/config/config.env'),
    false,
  )
})

test('does not change an existing target when the temporary write fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qwaudio-atomic-fail-'))
  const targetPath = join(directory, 'config.env')
  await writeFile(targetPath, 'original\n')
  const failure = new Error('write failed')
  const fs = {
    async writeFile() {
      throw failure
    },
    async rename() {
      assert.fail('rename must not run after a failed write')
    },
    async rm() {},
  }

  try {
    await assert.rejects(writeFileAtomic(targetPath, 'replacement\n', {
      fs,
      randomSuffix: () => 'write-failed',
    }), error => error === failure)
    assert.equal(await readFile(targetPath, 'utf8'), 'original\n')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('creates a real replacement file with mode 0600', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qwaudio-atomic-mode-'))
  const targetPath = join(directory, 'config.env')

  try {
    await writeFileAtomic(targetPath, 'VALUE=private\n', {
      randomSuffix: () => 'mode',
    })
    assert.equal(await readFile(targetPath, 'utf8'), 'VALUE=private\n')
    assert.equal((await stat(targetPath)).mode & 0o777, 0o600)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
