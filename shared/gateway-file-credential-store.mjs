import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { replaceFileSync, withFileTransaction } from './file-transaction-lock.mjs'
import { defineGatewayCredentialStore } from './gateway-connection-profiles.mjs'

function readDocument(filePath) {
  try {
    const value = JSON.parse(readFileSync(filePath, 'utf8'))
    return value?.version === 1 && value.credentials && typeof value.credentials === 'object'
      ? value
      : { version: 1, credentials: {} }
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: 1, credentials: {} }
    throw error
  }
}

function writeDocument(filePath, document) {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  replaceFileSync(temporary, filePath)
  chmodSync(filePath, 0o600)
}

// Terminal clients have no portable OS keychain API. Store only revocable
// Gateway device credentials in an owner-only file; cloud and model secrets
// remain outside this store. GUI clients should inject their platform vault.
export function createPrivateFileGatewayCredentialStore({ filePath }) {
  if (!filePath) throw new TypeError('Gateway credential file requires filePath')
  return defineGatewayCredentialStore({
    get: async key => readDocument(filePath).credentials[key] || null,
    set: async (key, value) => withFileTransaction(filePath, () => {
      const document = readDocument(filePath)
      document.credentials[key] = String(value)
      writeDocument(filePath, document)
    }),
    delete: async key => withFileTransaction(filePath, () => {
      const document = readDocument(filePath)
      if (!(key in document.credentials)) return false
      delete document.credentials[key]
      writeDocument(filePath, document)
      return true
    }),
  })
}
