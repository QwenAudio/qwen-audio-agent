// Startup preflight: fail fast with actionable messages before the Gateway or
// any native media resource is allocated. Checks are ordered cheapest-first and
// never log secrets (only the renderer origin, never its tokens).

import { createServer } from 'node:http'
import { requireWebRtcDependencies } from '../../../shared/gateway/webrtc.mjs'

export function checkWebRtcExtension() {
  const { version, apiVersion } = requireWebRtcDependencies()
  return { ok: true, version, apiVersion }
}

export async function checkPortFree(host, port) {
  return new Promise(resolve => {
    const probe = createServer()
    probe.once('error', error => {
      probe.close()
      resolve(error.code === 'EADDRINUSE'
        ? { ok: false, code: 'port_in_use', message: `port ${port} on ${host} is already in use` }
        : { ok: false, code: 'port_error', message: error.message })
    })
    probe.once('listening', () => probe.close(() => resolve({ ok: true })))
    probe.listen(port, host)
  })
}

export async function checkRendererReady(rendererUrl, { timeoutMs = 4000 } = {}) {
  try {
    const response = await fetch(`${rendererUrl.replace(/\/$/, '')}/health/ready`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return { ok: false, code: 'renderer_not_ready', message: `renderer /health/ready returned HTTP ${response.status}` }
    return { ok: true, ...(await response.json().catch(() => ({}))) }
  } catch (error) {
    return { ok: false, code: 'renderer_unreachable', message: `cannot reach renderer at ${rendererUrl}: ${error.message}` }
  }
}

export async function preflight({ gatewayHost, gatewayPort, rendererUrl }) {
  const results = []
  try {
    results.push({ name: 'webrtc_extension', ...checkWebRtcExtension() })
  } catch (error) {
    results.push({ name: 'webrtc_extension', ok: false, code: error.code || 'webrtc_extension_missing', message: error.message })
  }
  results.push({ name: 'gateway_port', ...(await checkPortFree(gatewayHost, gatewayPort)) })
  if (rendererUrl) results.push({ name: 'renderer_ready', ...(await checkRendererReady(rendererUrl)) })
  const failed = results.filter(result => !result.ok)
  return { ok: failed.length === 0, results, failed }
}
