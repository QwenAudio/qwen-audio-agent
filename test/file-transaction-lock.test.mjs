import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { withFileTransaction } from '../shared/file-transaction-lock.mjs'

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'qwa-file-transaction-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const filePath = join(root, 'shared.json')
  return { filePath, lockPath: `${filePath}.lock` }
}

function mockFs(t, method, implementation) {
  const mocked = t.mock.method(fs, method, implementation)
  syncBuiltinESMExports()
  t.after(() => {
    mocked.mock.restore()
    syncBuiltinESMExports()
  })
}

test('releases the transaction lock on success and on failure', t => {
  const { filePath, lockPath } = fixture(t)
  assert.equal(withFileTransaction(filePath, () => {
    assert.equal(fs.existsSync(lockPath), true)
    return 42
  }), 42)
  assert.equal(fs.existsSync(lockPath), false)
  const failure = new Error('transaction failed')
  assert.throws(() => withFileTransaction(filePath, () => { throw failure }), failure)
  assert.equal(fs.existsSync(lockPath), false)
})

test('does not steal a replacement lock after observing ENOENT during contention', t => {
  const { filePath, lockPath } = fixture(t)
  fs.mkdirSync(lockPath)
  const originalStat = fs.statSync
  let observedMissingLock = false
  mockFs(t, 'statSync', (path, ...args) => {
    if (path !== lockPath || observedMissingLock) return originalStat(path, ...args)
    observedMissingLock = true
    // A releases after our mkdir returned EEXIST. Our stat sees ENOENT, but
    // B acquires before we handle that result. B's new lock must survive.
    fs.rmSync(lockPath, { recursive: true })
    fs.mkdirSync(lockPath)
    fs.writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({ token: 'owner-b' }))
    throw Object.assign(new Error('lock disappeared'), { code: 'ENOENT' })
  })

  let ran = false
  assert.throws(() => withFileTransaction(filePath, () => { ran = true }, {
    timeoutMs: 0,
  }), { code: 'shared_file_busy' })
  assert.equal(observedMissingLock, true)
  assert.equal(ran, false)
  assert.equal(JSON.parse(fs.readFileSync(join(lockPath, 'owner.json'))).token, 'owner-b')
})

for (const code of ['EACCES', 'EPERM', 'EIO']) {
  test(`does not reclaim a lock whose metadata cannot be read (${code})`, t => {
    const { filePath, lockPath } = fixture(t)
    fs.mkdirSync(lockPath)
    const originalStat = fs.statSync
    const failure = Object.assign(new Error('cannot inspect lock'), { code })
    mockFs(t, 'statSync', (path, ...args) => {
      if (path === lockPath) throw failure
      return originalStat(path, ...args)
    })
    let ran = false
    assert.throws(() => withFileTransaction(filePath, () => { ran = true }), failure)
    assert.equal(ran, false)
    assert.equal(fs.existsSync(lockPath), true)
  })
}

test('times out without removing a recent lock', t => {
  const { filePath, lockPath } = fixture(t)
  fs.mkdirSync(lockPath)
  assert.throws(() => withFileTransaction(filePath, () => assert.fail('lock stolen'), {
    timeoutMs: 0,
  }), { code: 'shared_file_busy' })
  assert.equal(fs.existsSync(lockPath), true)
})

for (const kind of ['directory', 'legacy file']) {
  test(`recovers an abandoned ${kind} lock after the stale interval`, t => {
    const { filePath, lockPath } = fixture(t)
    if (kind === 'directory') fs.mkdirSync(lockPath)
    else fs.writeFileSync(lockPath, '{}')
    const past = new Date(Date.now() - 60_000)
    fs.utimesSync(lockPath, past, past)
    assert.equal(withFileTransaction(filePath, () => 'recovered'), 'recovered')
    assert.equal(fs.existsSync(lockPath), false)
  })
}
