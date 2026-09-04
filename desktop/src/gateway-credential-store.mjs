import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { replaceFileSync, withFileTransaction } from '../../shared/file-transaction-lock.mjs'
import { defineGatewayCredentialStore } from '../../shared/gateway-connection-profiles.mjs'

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

function writeDocument(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  replaceFileSync(temporary, filePath)
  chmodSync(filePath, 0o600)
}

export function createElectronGatewayCredentialStore({ filePath, safeStorage }) {
  if (!filePath) throw new TypeError('Electron Gateway credential store requires filePath')
  if (!safeStorage?.encryptString || !safeStorage?.decryptString) {
    throw new TypeError('Electron Gateway credential store requires safeStorage')
  }
  return defineGatewayCredentialStore({
    get: async key => {
      const encoded = readDocument(filePath).credentials[key]
      if (!encoded) return null
      return safeStorage.decryptString(Buffer.from(encoded, 'base64'))
    },
    set: async (key, value) => withFileTransaction(filePath, () => {
      const document = readDocument(filePath)
      document.credentials[key] = safeStorage.encryptString(String(value)).toString('base64')
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
