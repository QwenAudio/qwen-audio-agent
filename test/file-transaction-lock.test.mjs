import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  removeFileSync,
  removeTreeSync,
  withFileTransaction,
} from '../shared/file-transaction-lock.mjs'

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

// Windows + Node 24 的 fs.rmSync 会把非 ASCII 路径按当前代码页重新解释：中文名目标
// 要么删不掉（force 吞掉 ENOENT），要么落到同目录下恰好叫那个乱码名的另一个文件上。
// 这两个删除入口走 libuv 的 unlink/rmdir，中文名是最容易踩到的场景，这里钉住行为。
test('removes non-ASCII paths instead of mangling them', t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'qwa-file-transaction-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = join(root, '手册.md')
  fs.writeFileSync(file, '# 手册')
  const directory = join(root, '资料库')
  fs.mkdirSync(join(directory, 'nested'), { recursive: true })
  fs.writeFileSync(join(directory, 'nested', '二册.md'), '# 二册')

  assert.equal(removeFileSync(file), true)
  assert.equal(fs.existsSync(file), false)
  assert.equal(removeTreeSync(directory), true)
  assert.equal(fs.existsSync(directory), false)
  // 已经不在了算成功 —— 与 rmSync({ force: true }) 的语义一致
  assert.equal(removeFileSync(file), false)
  assert.equal(removeTreeSync(directory), false)
})
