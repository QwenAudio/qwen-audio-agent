export async function readGatewayHealth(baseUrl, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`${baseUrl}/api/health`, {
      signal: AbortSignal.timeout(1500),
    })
    const payload = await response.json()
    return payload && typeof payload === 'object' && payload.backend
      ? payload
      : null
  } catch {
    return null
  }
}

export async function createGatewayPairingTicket(baseUrl, fetchImpl = fetch) {
  const response = await fetchImpl(`${baseUrl}/api/access/pairing-tickets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(3000),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || !payload.code) {
    const error = new Error(payload.error || `Gateway returned HTTP ${response.status}`)
    error.code = payload.code || 'pairing_ticket_failed'
    throw error
  }
  return payload
}

export async function pairGatewayDevice(
  baseUrl,
  { code, device } = {},
  fetchImpl = fetch,
) {
  const response = await fetchImpl(`${baseUrl}/api/access/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, device }),
    signal: AbortSignal.timeout(5000),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || !payload.access_token) {
    const error = new Error(payload.error || `Gateway returned HTTP ${response.status}`)
    error.code = payload.code || 'gateway_pairing_failed'
    throw error
  }
  return payload
}

async function gatewayManagementRequest(baseUrl, path, options, fetchImpl) {
  const response = await fetchImpl(`${baseUrl}${path}`, {
    ...options,
    signal: AbortSignal.timeout(3000),
  })
  const payload = response.status === 204
    ? null
    : await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(payload?.error || `Gateway returned HTTP ${response.status}`)
    error.code = payload?.code || 'gateway_management_failed'
    throw error
  }
  return payload
}

export function listGatewayDevices(baseUrl, fetchImpl = fetch) {
  return gatewayManagementRequest(
    baseUrl,
    '/api/access/devices',
    { method: 'GET' },
    fetchImpl,
  )
}

export function revokeGatewayDevice(baseUrl, deviceId, fetchImpl = fetch) {
  return gatewayManagementRequest(
    baseUrl,
    `/api/access/devices/${encodeURIComponent(deviceId)}`,
    { method: 'DELETE' },
    fetchImpl,
  )
}
