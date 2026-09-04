import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { replaceFileSync, withFileTransaction } from './file-transaction-lock.mjs'
import {
  GATEWAY_REMOTE_ACCESS_MODEL_VERSION,
  GatewayConnectionProfileSchema,
  parseGatewayConnectionProfile,
} from './gateway-remote-access.mjs'

const ProfileDocumentSchema = z.object({
  version: z.literal(GATEWAY_REMOTE_ACCESS_MODEL_VERSION),
  profiles: z.array(GatewayConnectionProfileSchema),
}).strict()

export function defineGatewayCredentialStore({ get, set, delete: remove }) {
  for (const [name, implementation] of Object.entries({ get, set, delete: remove })) {
    if (typeof implementation !== 'function') {
      throw new TypeError(`Gateway credential store requires ${name}()`)
    }
  }
  return Object.freeze({ get, set, delete: remove })
}

function readProfiles(filePath) {
  try {
    return ProfileDocumentSchema.parse(JSON.parse(readFileSync(filePath, 'utf8'))).profiles
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    const wrapped = new Error(`Invalid Gateway connection profile store: ${error.message}`)
    wrapped.code = 'gateway_connection_profiles_invalid'
    throw wrapped
  }
}

function writeProfiles(filePath, profiles) {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(temporary, `${JSON.stringify({
    version: GATEWAY_REMOTE_ACCESS_MODEL_VERSION,
    profiles,
  }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  replaceFileSync(temporary, filePath)
  chmodSync(filePath, 0o600)
}

export class GatewayConnectionProfileStore {
  constructor({ filePath, credentialStore }) {
    if (!filePath) throw new TypeError('Gateway connection profile store requires filePath')
    this.filePath = filePath
    this.credentials = defineGatewayCredentialStore(credentialStore)
  }

  list() {
    return withFileTransaction(this.filePath, () => readProfiles(this.filePath))
  }

  get(id) {
    return this.list().find(profile => profile.id === id) || null
  }

  async resolve(id) {
    const profile = this.get(id)
    if (!profile) return null
    return {
      profile,
      credential: await this.credentials.get(profile.credential_ref),
    }
  }

  async save(profile, credential) {
    const parsed = parseGatewayConnectionProfile(profile)
    if (!String(credential || '').trim()) {
      throw new TypeError('Gateway connection profile requires a credential')
    }
    const previousCredential = await this.credentials.get(parsed.credential_ref)
    await this.credentials.set(parsed.credential_ref, credential)
    try {
      withFileTransaction(this.filePath, () => {
        const profiles = readProfiles(this.filePath)
        const index = profiles.findIndex(current => current.id === parsed.id)
        if (index === -1) profiles.push(parsed)
        else profiles[index] = parsed
        writeProfiles(this.filePath, profiles)
      })
    } catch (error) {
      if (previousCredential === null || previousCredential === undefined) {
        await this.credentials.delete(parsed.credential_ref)
      } else {
        await this.credentials.set(parsed.credential_ref, previousCredential)
      }
      throw error
    }
    return parsed
  }

  async remove(id) {
    let removed = null
    withFileTransaction(this.filePath, () => {
      const profiles = readProfiles(this.filePath)
      removed = profiles.find(profile => profile.id === id) || null
      if (!removed) return
      writeProfiles(this.filePath, profiles.filter(profile => profile.id !== id))
    })
    if (removed) await this.credentials.delete(removed.credential_ref)
    return Boolean(removed)
  }
}

export function createMemoryGatewayCredentialStore() {
  const values = new Map()
  return defineGatewayCredentialStore({
    get: async key => values.get(key) || null,
    set: async (key, value) => { values.set(key, value) },
    delete: async key => values.delete(key),
  })
}
