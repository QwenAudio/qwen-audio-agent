import { randomUUID } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4))

function readOwner(lockPath) {
  for (const path of [`${lockPath}/owner.json`, lockPath]) {
    try {
      return JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      // The second path keeps stale file locks from an older release
      // recoverable after the lock representation changed to a directory.
    }
  }
  return null
}

function lockIsStale(lockPath, now, staleMs) {
  try {
    return now() - statSync(lockPath).mtimeMs >= staleMs
  } catch (error) {
    // A released lock is not a stale lock. Another process can acquire this
    // path before we handle ENOENT; reclaiming it would delete that new lock.
    // Retry acquisition instead. Other stat failures are not proof of expiry
    // either, and must surface without touching a possibly live owner's lock.
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function reclaim(lockPath, token) {
  const stalePath = `${lockPath}.stale.${token}`
  try {
    renameSync(lockPath, stalePath)
  } catch {
    return false
  }
  removeTreeSync(stalePath)
  return true
}

function acquire(filePath, {
  timeoutMs = 2000,
  retryMs = 10,
  staleMs = 30_000,
  now = Date.now,
} = {}) {
  const lockPath = `${filePath}.lock`
  const token = randomUUID()
  const deadline = now() + timeoutMs
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })

  while (true) {
    const owner = { token, pid: process.pid, createdAt: now() }
    try {
      // Directory creation is the lock primitive. It is atomic on the local
      // filesystems supported by Desktop and CLI, and avoids exposing the
      // partially written owner record of a file-based lock.
      mkdirSync(lockPath, { mode: 0o700 })
      try {
        writeFileSync(
          `${lockPath}/owner.json`,
          `${JSON.stringify(owner)}\n`,
          { encoding: 'utf8', mode: 0o600 },
        )
      } catch (error) {
        // Another contender may have reclaimed a just-created lock directory
        // after observing it before owner.json was written. Treat that narrow
        // initialization race like a lost acquire attempt instead of failing
        // the caller's transaction.
        if (error?.code === 'ENOENT') continue
        removeTreeSync(lockPath)
        throw error
      }
      return () => {
        const current = readOwner(lockPath)
        if (current?.token !== token) return false
        return reclaim(lockPath, `released.${token}`)
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      // Reclaim by age, not PID probing. PID visibility differs across hosts
      // and containers and can make two live processes both believe they own
      // the same transaction. Transactions here are synchronous and short;
      // an abandoned lock is recovered after the bounded stale interval.
      const stale = lockIsStale(lockPath, now, staleMs)
      if (stale && reclaim(lockPath, token)) continue
      if (now() >= deadline) {
        const timeout = new Error(`timed out waiting for shared file lock: ${filePath}`)
        timeout.code = 'shared_file_busy'
        throw timeout
      }
      Atomics.wait(sleepBuffer, 0, 0, Math.min(retryMs, Math.max(1, deadline - now())))
    }
  }
}

// Shared profile files are deliberately writable by both the Desktop and CLI
// Gateways. Keep each read-modify-write operation inside one cross-process
// transaction so independent runtimes cannot silently overwrite each other.
export function withFileTransaction(filePath, action, options) {
  if (!filePath) return action()
  const release = acquire(filePath, options)
  try {
    return action()
  } finally {
    release()
  }
}

const WINDOWS_REPLACE_ERRORS = new Set(['EACCES', 'EBUSY', 'EPERM'])

function retryWindowsRename(source, target, retries, retryMs) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(source, target)
      return
    } catch (error) {
      if (
        !WINDOWS_REPLACE_ERRORS.has(error?.code)
        || attempt >= retries
      ) {
        throw error
      }
      Atomics.wait(sleepBuffer, 0, 0, retryMs)
    }
  }
}

// Windows rename cannot consistently replace an existing destination and can
// also be delayed by a reader or antivirus. Preserve the old destination while
// replacing it and retry only the documented class of sharing failures.
export function replaceFileSync(temporaryPath, targetPath, {
  retries = 20,
  retryMs = 10,
} = {}) {
  if (process.platform !== 'win32') {
    renameSync(temporaryPath, targetPath)
    return
  }

  try {
    renameSync(temporaryPath, targetPath)
    return
  } catch (error) {
    if (!WINDOWS_REPLACE_ERRORS.has(error?.code)) throw error
  }

  // Windows rename does not consistently replace an existing destination.
  // Preserve the previous file as a recoverable backup while moving the new
  // one into place. Shared-file callers hold the transaction lock while this
  // small compatibility window is open.
  const backupPath = `${targetPath}.replace.${randomUUID()}.bak`
  try {
    retryWindowsRename(targetPath, backupPath, retries, retryMs)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    retryWindowsRename(temporaryPath, targetPath, retries, retryMs)
    return
  }
  try {
    retryWindowsRename(temporaryPath, targetPath, retries, retryMs)
  } catch (error) {
    try {
      retryWindowsRename(backupPath, targetPath, retries, retryMs)
    } catch {
      // Keep the backup on disk when rollback itself is blocked.
    }
    throw error
  }
  removeFileSync(backupPath)
}

// Windows + Node 24 上 fs.rmSync 走的是 C++ 绑定（binding.rmSync），路径是按当前
// ANSI 代码页而不是 UTF-8 解释的：非 ASCII 目标会变成另一个名字 —— 删除要么静默
// 无效（force 把 ENOENT 吞了），要么作用到同目录下恰好叫那个乱码名的文件上。下面
// 两个删除入口走 libuv 的 unlinkSync / rmdirSync（UTF-8 → UTF-16 转换，名字不会
// 走样），语义与 rmSync({ force: true }) / rmSync({ recursive: true, force: true })
// 对齐：目标本来就不在算成功，其它失败照旧抛出。
export function removeFileSync(target) {
  try {
    unlinkSync(target)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

// 逐层自己走目录，而不是 rmSync({ recursive: true })：递归删除同样按代码页解释
// 路径，非 ASCII 目录会整个留在原地。符号链接按链接本身删除，不跟随进目标
// —— 与 rmSync 一致。
export function removeTreeSync(target) {
  let stats
  try {
    stats = lstatSync(target)
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
  if (!stats.isDirectory()) return removeFileSync(target)
  for (const name of readdirSync(target)) removeTreeSync(join(target, name))
  rmdirSync(target)
  return true
}
