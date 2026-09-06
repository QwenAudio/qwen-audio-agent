import { openAsBlob } from 'node:fs'

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

function positiveInteger(value, fallback) {
  const number = Math.trunc(Number(value))
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function endpoint(value) {
  const url = new URL(String(value || '').trim())
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new TypeError('LIGHTRAG_URL must use HTTP or HTTPS')
  }
  url.username = ''
  url.password = ''
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/`
  return url
}

function errorMessage(payload, fallback) {
  return String(payload?.detail ?? payload?.message ?? fallback ?? '').trim()
}

export class LightRagHttpError extends Error {
  constructor(message, { status = 0, retryable = false, code = 'lightrag_error' } = {}) {
    super(message)
    this.name = 'LightRagHttpError'
    this.status = status
    this.retryable = retryable
    this.code = code
  }
}

export class LightRagClient {
  constructor({
    baseUrl,
    apiKey = '',
    workspace = '',
    fetchImpl = globalThis.fetch,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  } = {}) {
    if (typeof fetchImpl !== 'function') {
      throw new TypeError('LightRagClient requires fetch')
    }
    this.baseUrl = endpoint(baseUrl)
    this.apiKey = String(apiKey || '').trim()
    this.workspace = String(workspace || '').trim()
    this.fetch = fetchImpl
    this.requestTimeoutMs = positiveInteger(
      requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
    )
  }

  headers(extra = {}) {
    return {
      Accept: 'application/json',
      ...(this.apiKey ? { 'X-API-Key': this.apiKey } : {}),
      ...(this.workspace ? { 'LIGHTRAG-WORKSPACE': this.workspace } : {}),
      ...extra,
    }
  }

  async request(path, {
    method = 'GET',
    body,
    signal,
    timeoutMs = this.requestTimeoutMs,
  } = {}) {
    const timeoutSignal = AbortSignal.timeout(positiveInteger(
      timeoutMs,
      this.requestTimeoutMs,
    ))
    const requestSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal
    const jsonBody = body != null && !(body instanceof FormData)
    let response
    try {
      response = await this.fetch(new URL(path.replace(/^\//u, ''), this.baseUrl), {
        method,
        headers: this.headers(jsonBody ? { 'Content-Type': 'application/json' } : {}),
        ...(body == null ? {} : { body: jsonBody ? JSON.stringify(body) : body }),
        signal: requestSignal,
      })
    } catch (error) {
      if (requestSignal.aborted) throw requestSignal.reason
      throw new LightRagHttpError('无法连接 LightRAG 服务。', {
        retryable: true,
        code: 'lightrag_unreachable',
      })
    }
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      const status = Number(response.status) || 0
      throw new LightRagHttpError(
        errorMessage(payload, `LightRAG request failed (${status})`),
        {
          status,
          retryable: status === 408 || status === 409 || status === 429 || status >= 500,
          code: status === 409
            ? 'lightrag_conflict'
            : status === 429 ? 'lightrag_busy' : 'lightrag_request_failed',
        },
      )
    }
    return payload
  }

  async uploadFile(path, { name, signal, timeoutMs } = {}) {
    const form = new FormData()
    form.append(
      'file',
      await openAsBlob(path),
      String(name || '').trim() || 'document',
    )
    return this.request('/documents/upload', {
      method: 'POST',
      body: form,
      signal,
      timeoutMs,
    })
  }
}
