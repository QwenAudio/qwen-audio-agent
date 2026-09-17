const DEFAULT_BACKOFF_MS = 30_000

function clean(value) {
  return String(value || '').trim()
}

export function backendFailureCode(error) {
  const code = clean(error?.code || error?.cause?.code).toUpperCase()
  const message = clean(error?.message || error).toLowerCase()
  if (code === 'ENOENT') return 'NOT_INSTALLED'
  if (/api key|credential|not configured|未配置|凭据/.test(message)) {
    return 'CONFIG_REQUIRED'
  }
  if (/unauth|not logged in|login|认证|登录/.test(message)) {
    return 'AUTH_REQUIRED'
  }
  if (/protocol version|协议版本/.test(message)) return 'PROTOCOL_MISMATCH'
  if (/timeout|timed out|超时/.test(message)) return 'START_TIMEOUT'
  if (/exited|退出/.test(message)) return 'PROCESS_EXITED'
  return 'START_FAILED'
}

export class BackendRuntimeState {
  constructor({
    protocol,
    ownership,
    connectionKind,
    label,
    stderr = () => '',
    now = () => Date.now(),
    backoffMs = DEFAULT_BACKOFF_MS,
  }) {
    this.protocol = protocol
    this.ownership = ownership
    this.connectionKind = connectionKind || null
    this.label = label
    this.stderr = stderr
    this.now = now
    this.backoffMs = backoffMs
    this.lastFailure = null
    this.value = this.base({
      ok: false,
      status: 'stopped',
      code: 'NOT_STARTED',
    })
  }

  base(fields) {
    return {
      ...fields,
      protocol: this.protocol,
      ownership: this.ownership,
      transport: 'acp',
      acpConnection: this.connectionKind,
    }
  }

  shouldBackoff() {
    return Boolean(
      this.lastFailure
      && this.now() - this.lastFailure.at < this.backoffMs
    )
  }

  status({ clientReady = true } = {}) {
    if (this.value.ok && clientReady === false) {
      return {
        ...this.value,
        ok: false,
        status: 'stopped',
        code: 'PROCESS_EXITED',
        error: `${this.label} ACP 进程已退出`,
      }
    }
    if (!this.lastFailure) return { ...this.value }
    return {
      ...this.value,
      retryAfterMs: Math.max(
        0,
        this.backoffMs - (this.now() - this.lastFailure.at),
      ),
    }
  }

  starting(error = '') {
    this.value = this.base({
      ...this.value,
      ok: false,
      status: 'starting',
      code: 'STARTING',
      error,
    })
  }

  waiting(message) {
    this.value = this.base({
      ok: false,
      status: 'starting',
      code: 'BACKEND_STARTING',
      error: message,
    })
  }

  ready(initialized) {
    this.lastFailure = null
    this.value = this.base({
      ok: true,
      status: 'ready',
      code: 'READY',
      agentInfo: initialized?.agentInfo || null,
      capabilities: initialized?.agentCapabilities || {},
    })
  }

  failed(error) {
    const stderr = clean(this.stderr())
    this.value = this.base({
      ok: false,
      status: 'failed',
      code: backendFailureCode(error),
      error: `${error.message}${stderr ? `：${stderr}` : ''}`,
    })
    this.lastFailure = { at: this.now(), result: this.value }
  }

  stopped() {
    this.lastFailure = null
    this.value = this.base({
      ...this.value,
      ok: false,
      status: 'stopped',
      code: 'STOPPED',
      error: '',
    })
  }
}
