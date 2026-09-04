import {
  createHmac,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto'
import { VersionedJsonStore } from '../core/versioned-json-store.mjs'
import { gatewayWebSocketBearer } from '../../../shared/gateway-websocket-auth.mjs'

const ACCESS_COOKIE = 'qwen_audio_agent_access'
const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const DEFAULT_PAIRING_TTL_MS = 5 * 60 * 1000
const DEVICE_LAST_USED_WRITE_INTERVAL_MS = 60 * 60 * 1000
const OWNER_ID_PATTERN = /^user_[A-Za-z0-9._-]+$/

function clean(value) {
  return String(value || '').trim()
}

function cookies(header = '') {
  return Object.fromEntries(
    String(header)
      .split(';')
      .map(part => part.trim())
      .filter(Boolean)
      .map(part => {
        const separator = part.indexOf('=')
        if (separator < 0) return [part, '']
        try {
          return [part.slice(0, separator), decodeURIComponent(part.slice(separator + 1))]
        } catch {
          return [part.slice(0, separator), '']
        }
      }),
  )
}

function digest(value) {
  return createHash('sha256').update(String(value)).digest('base64url')
}

function normalizeOwnerId(value) {
  const normalized = clean(value)
  if (!OWNER_ID_PATTERN.test(normalized)) {
    throw new Error(`Gateway 远程访问 ownerId 无效：${normalized}`)
  }
  return normalized
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left))
  const b = Buffer.from(String(right))
  return a.length === b.length && timingSafeEqual(a, b)
}

function bearerToken(header = '') {
  const match = String(header).match(/^Bearer\s+([^\s]+)$/i)
  return match?.[1] || ''
}

function secureRequest(req) {
  return Boolean(
    req.socket?.encrypted
    || String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https',
  )
}

export function isLoopbackRequest(req = {}) {
  let hostname = ''
  try {
    hostname = new URL(`http://${req.headers?.host || ''}`).hostname
  } catch {
    return false
  }
  const remoteAddress = clean(req.socket?.remoteAddress).replace(/^::ffff:/, '')
  const loopbackHost = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname)
  const loopbackPeer = !remoteAddress
    || remoteAddress === '127.0.0.1'
    || remoteAddress === '::1'
  return loopbackHost && loopbackPeer
}

export function parseGatewayAccessKeys({
  accessToken = '',
  accessKeys = '',
  personalOwnerId = 'user_personal',
} = {}) {
  const records = []
  const add = (token, ownerId, label = '') => {
    const value = clean(token)
    const owner = clean(ownerId)
    if (!value) return
    if (value.length < 24) {
      throw new Error('Gateway 远程访问密钥至少需要 24 个字符')
    }
    normalizeOwnerId(owner)
    const tokenHash = digest(value)
    if (records.some(record => record.tokenHash === tokenHash)) {
      throw new Error('Gateway 远程访问密钥不能重复')
    }
    records.push({
      id: `key_${tokenHash.slice(0, 16)}`,
      tokenHash,
      ownerId: owner,
      label: clean(label).slice(0, 80),
    })
  }

  add(accessToken, personalOwnerId, 'personal')
  const source = clean(accessKeys)
  if (source) {
    let parsed
    try {
      parsed = JSON.parse(source)
    } catch {
      throw new Error('QWEN_AUDIO_AGENT_ACCESS_KEYS 必须是有效的 JSON 数组')
    }
    if (!Array.isArray(parsed)) {
      throw new Error('QWEN_AUDIO_AGENT_ACCESS_KEYS 必须是 JSON 数组')
    }
    for (const entry of parsed) {
      add(entry?.token, entry?.owner_id || entry?.ownerId, entry?.label)
    }
  }
  return records
}

export class GatewayDeviceRegistry {
  constructor({ filePath = null, now = () => Date.now(), onWarning } = {}) {
    this.now = now
    this.store = new VersionedJsonStore({
      filePath,
      version: 1,
      label: 'Gateway 远程设备',
      now,
      onWarning,
    })
    const snapshot = this.store.load({
      fallback: () => ({ devices: [] }),
      validate: value => Array.isArray(value.devices),
    })
    this.devices = new Map(snapshot.devices
      .filter(device => (
        clean(device.id)
        && clean(device.ownerId)
        && clean(device.tokenHash)
      ))
      .map(device => [device.id, { ...device }]))
  }

  create({ ownerId, device = {} } = {}) {
    const token = `qwa_${randomBytes(32).toString('base64url')}`
    const tokenHash = digest(token)
    const id = clean(device.id).slice(0, 128) || `device_${randomUUID()}`
    const ownerIdValue = normalizeOwnerId(ownerId)
    const record = {
      id,
      ownerId: ownerIdValue,
      tokenId: `device_key_${tokenHash.slice(0, 16)}`,
      tokenHash,
      type: clean(device.type).slice(0, 40) || 'remote',
      label: clean(device.label).slice(0, 80),
      createdAt: this.now(),
      lastUsedAt: null,
    }
    this.devices.set(id, record)
    this.persist()
    return {
      token,
      credentialId: record.tokenId,
      device: this.publicRecord(record),
    }
  }

  findToken(token) {
    const tokenHash = digest(token)
    for (const record of this.devices.values()) {
      if (!safeEqual(record.tokenHash, tokenHash)) continue
      const usedAt = this.now()
      if (
        record.lastUsedAt == null
        || usedAt - record.lastUsedAt >= DEVICE_LAST_USED_WRITE_INTERVAL_MS
      ) {
        record.lastUsedAt = usedAt
        this.persist()
      }
      return record
    }
    return null
  }

  hasTokenId(tokenId, ownerId) {
    return [...this.devices.values()].some(record => (
      record.tokenId === tokenId && record.ownerId === ownerId
    ))
  }

  list(ownerId) {
    return [...this.devices.values()]
      .filter(record => !ownerId || record.ownerId === ownerId)
      .map(record => this.publicRecord(record))
  }

  credentialId(id, ownerId) {
    const record = this.devices.get(clean(id))
    if (!record || (ownerId && record.ownerId !== ownerId)) return null
    return record.tokenId
  }

  revoke(id, ownerId) {
    const record = this.devices.get(clean(id))
    if (!record || (ownerId && record.ownerId !== ownerId)) return false
    this.devices.delete(record.id)
    this.persist()
    return true
  }

  publicRecord(record) {
    return {
      id: record.id,
      ownerId: record.ownerId,
      type: record.type,
      label: record.label,
      createdAt: record.createdAt,
      lastUsedAt: record.lastUsedAt,
    }
  }

  persist() {
    this.store.save({ devices: [...this.devices.values()] })
  }

  health() {
    return this.store.health()
  }
}

export class GatewayAccessManager {
  constructor({
    identityManager,
    secret,
    configuredKeys = [],
    deviceRegistry = new GatewayDeviceRegistry(),
    personalOwnerId = 'user_personal',
    sessionTtlMs = DEFAULT_SESSION_TTL_MS,
    pairingTtlMs = DEFAULT_PAIRING_TTL_MS,
    now = () => Date.now(),
  } = {}) {
    if (!identityManager) throw new TypeError('identityManager is required')
    if (!secret || String(secret).length < 32) {
      throw new Error('Gateway access secret must contain at least 32 characters')
    }
    this.identityManager = identityManager
    this.secret = String(secret)
    this.configuredKeys = [...configuredKeys]
    this.deviceRegistry = deviceRegistry
    this.personalOwnerId = clean(personalOwnerId) || 'user_personal'
    this.sessionTtlMs = Math.max(60_000, Number(sessionTtlMs) || DEFAULT_SESSION_TTL_MS)
    this.pairingTtlMs = Math.max(30_000, Number(pairingTtlMs) || DEFAULT_PAIRING_TTL_MS)
    this.now = now
    this.pairingTickets = new Map()
  }

  get remoteEnabled() {
    return this.configuredKeys.length > 0 || this.deviceRegistry.list().length > 0
  }

  resolveHttp(req, res) {
    if (isLoopbackRequest(req)) {
      return { ...this.identityManager.resolveHttp(req, res), access: 'local' }
    }
    const identity = this.resolveRemote(req)
    if (!identity) return null
    if (bearerToken(req.headers.authorization)) this.issueCookie(res, identity, req)
    return identity
  }

  resolveUpgrade(req) {
    if (isLoopbackRequest(req)) {
      const identity = this.identityManager.resolveUpgrade(req)
      return identity ? { ...identity, access: 'local' } : null
    }
    return this.resolveRemote(req, {
      webSocketBearer: gatewayWebSocketBearer(req.headers['sec-websocket-protocol']),
    })
  }

  resolveRemote(req, { webSocketBearer = '' } = {}) {
    const bearer = bearerToken(req.headers.authorization) || webSocketBearer
    if (bearer) {
      const credential = this.findCredential(bearer)
      if (!credential) return null
      return {
        ownerId: credential.ownerId,
        access: 'remote',
        credentialId: credential.tokenId || credential.id,
        clientType: credential.type || '',
      }
    }
    return this.resolveCookie(req.headers.cookie)
  }

  findCredential(token) {
    const tokenHash = digest(token)
    const configured = this.configuredKeys.find(record => (
      safeEqual(record.tokenHash, tokenHash)
    ))
    return configured || this.deviceRegistry.findToken(token)
  }

  createPairingTicket({ ownerId = this.personalOwnerId } = {}) {
    const code = randomBytes(10).toString('base64url')
    const record = {
      codeHash: digest(code),
      ownerId: normalizeOwnerId(ownerId),
      expiresAt: this.now() + this.pairingTtlMs,
    }
    this.pairingTickets.set(record.codeHash, record)
    this.prunePairingTickets()
    return { code, expiresAt: record.expiresAt }
  }

  redeemPairingTicket(code, { device } = {}) {
    this.prunePairingTickets()
    const codeHash = digest(clean(code))
    const record = this.pairingTickets.get(codeHash)
    if (!record || record.expiresAt <= this.now()) return null
    this.pairingTickets.delete(codeHash)
    return this.deviceRegistry.create({ ownerId: record.ownerId, device })
  }

  issueCookie(res, identity, req) {
    if (!res?.setHeader) return
    const expiresAt = this.now() + this.sessionTtlMs
    const payload = [
      identity.ownerId,
      identity.credentialId,
      String(expiresAt),
    ].map(value => Buffer.from(String(value)).toString('base64url')).join('.')
    const signature = createHmac('sha256', this.secret)
      .update(payload)
      .digest('base64url')
    const attributes = [
      `${ACCESS_COOKIE}=${encodeURIComponent(`${payload}.${signature}`)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${Math.floor(this.sessionTtlMs / 1000)}`,
    ]
    if (secureRequest(req)) attributes.push('Secure')
    res.setHeader('Set-Cookie', attributes.join('; '))
  }

  clearCookie(res, req) {
    const attributes = [
      `${ACCESS_COOKIE}=`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      'Max-Age=0',
    ]
    if (secureRequest(req)) attributes.push('Secure')
    res.setHeader('Set-Cookie', attributes.join('; '))
  }

  resolveCookie(header) {
    const token = cookies(header)[ACCESS_COOKIE]
    const parts = clean(token).split('.')
    if (parts.length !== 4) return null
    const payload = parts.slice(0, 3).join('.')
    const expected = createHmac('sha256', this.secret).update(payload).digest('base64url')
    if (!safeEqual(parts[3], expected)) return null
    let ownerId
    let credentialId
    let expiresAt
    try {
      ownerId = Buffer.from(parts[0], 'base64url').toString()
      credentialId = Buffer.from(parts[1], 'base64url').toString()
      expiresAt = Number(Buffer.from(parts[2], 'base64url').toString())
    } catch {
      return null
    }
    if (!Number.isFinite(expiresAt) || expiresAt <= this.now()) return null
    const configured = this.configuredKeys.some(record => (
      record.id === credentialId && record.ownerId === ownerId
    ))
    const device = this.deviceRegistry.hasTokenId(credentialId, ownerId)
    if (!configured && !device) return null
    return { ownerId, access: 'remote', credentialId }
  }

  prunePairingTickets() {
    const now = this.now()
    for (const [key, record] of this.pairingTickets) {
      if (record.expiresAt <= now) this.pairingTickets.delete(key)
    }
  }

  describe() {
    return {
      remoteEnabled: this.remoteEnabled,
      configuredKeys: this.configuredKeys.length,
      pairedDevices: this.deviceRegistry.list().length,
      deviceStore: this.deviceRegistry.health(),
    }
  }
}
