import { randomUUID } from 'node:crypto'
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

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

function malformedLockIsStale(lockPath, now, staleMs) {
  try {
    return now() - statSync(lockPath).mtimeMs >= staleMs
  } catch {
    return true
  }
}

function reclaim(lockPath, token) {
  const stalePath = `${lockPath}.stale.${token}`
  try {
    renameSync(lockPath, stalePath)
  } catch {
    return false
  }
  rmSync(stalePath, { recursive: true, force: true })
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
        rmSync(lockPath, { recursive: true, force: true })
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
      const stale = malformedLockIsStale(lockPath, now, staleMs)
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
  rmSync(backupPath, { force: true })
}
