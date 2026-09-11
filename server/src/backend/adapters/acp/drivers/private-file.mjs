import {
  chmodSync,
  mkdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

export function writePrivateFile(path, contents) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporaryPath = `${path}.tmp.${process.pid}`
  writeFileSync(temporaryPath, contents, { mode: 0o600 })
  chmodSync(temporaryPath, 0o600)
  renameSync(temporaryPath, path)
}
