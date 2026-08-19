import assert from 'node:assert/strict'
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { DictationSession } from '../src/dictation/dictation-session.mjs'

test('cancelled uncommitted dictation has zero disk and log side effects', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'qwaudio-dictation-'))
  const sentinel = join(directory, 'existing-state.json')
  writeFileSync(sentinel, '{"unchanged":true}\n')
  const beforeEntries = readdirSync(directory)
  const beforeContent = readFileSync(sentinel, 'utf8')
  const sent = []
  let callbacks
  const session = new DictationSession({
    send: event => sent.push(event),
    createTranscriber: nextCallbacks => {
      callbacks = nextCallbacks
      return {
        start: async () => {},
        appendAudio: () => {},
        close: () => {},
      }
    },
  })
  t.after(() => {
    session.close()
    rmSync(directory, { recursive: true, force: true })
  })

  await session.handle({
    type: 'dictation.start',
    sessionId: 'private-session',
    seq: 1,
  })
  await session.handle({
    type: 'dictation.audio.append',
    sessionId: 'private-session',
    seq: 2,
    audio: 'private-audio-never-persisted',
  })
  callbacks.onDelta('private partial text')
  await session.handle({
    type: 'dictation.cancel',
    sessionId: 'private-session',
    seq: 3,
  })

  assert.deepEqual(readdirSync(directory), beforeEntries)
  assert.equal(readFileSync(sentinel, 'utf8'), beforeContent)
  const sourceDirectory = fileURLToPath(new URL('../src/dictation/', import.meta.url))
  for (const name of readdirSync(sourceDirectory)) {
    const implementation = readFileSync(join(sourceDirectory, name), 'utf8')
    assert.doesNotMatch(implementation, /node:fs|createLogger|\.log\s*\(/)
  }
  assert.equal(
    sent.some(event => event.type === 'dictation.commit.request'),
    false,
  )
})
