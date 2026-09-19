import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

// Test-only provider: official DB/tool semantics, with the demo's approval boundary.
export class TauScenarios {
  constructor({ root, python = 'python3', timeoutMs = 60_000 } = {}) {
    if (!root) throw new Error('CS_TAU2_ROOT is required in test mode')
    this.root = root
    this.python = python
    this.timeoutMs = timeoutMs
    this.sessions = new Map()
    this.pending = new Map()
    this.approvals = new Map()
    this.loading = 0
  }

  owns(sessionId) { return String(sessionId).startsWith('tau-') }

  context(sessionId) {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('Unknown or released tau session')
    return session
  }

  start() {
    if (this.worker) return
    const worker = spawn(this.python,
      [fileURLToPath(new URL('./tau-worker.py', import.meta.url)), this.root], {
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1',
          TAU2_DATA_DIR: `${this.root}/data`, DOTENV_DISABLED: '1' },
        stdio: ['pipe', 'pipe', 'ignore'],
      })
    this.worker = worker
    const lines = createInterface({ input: worker.stdout })
    lines.on('line', line => {
      let message
      try { message = JSON.parse(line) } catch { this.fail(new Error('Invalid tau worker response')); return }
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(message.error))
      else pending.resolve(message.result)
    })
    worker.on('error', error => { if (this.worker === worker) this.fail(error) })
    worker.on('exit', code => {
      lines.close()
      if (this.worker === worker) this.fail(new Error(`tau worker exited (${code}); check CS_TAU2_PYTHON dependencies`))
    })
    worker.stdin.on('error', error => { if (this.worker === worker) this.fail(error) })
  }

  fail(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    this.sessions.clear()
    this.approvals.clear()
    this.worker?.kill()
    this.worker = null
  }

  request(method, sessionId, payload = {}) {
    if (this.closed) return Promise.reject(new Error('tau provider closed'))
    this.start()
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('tau worker request timed out')), this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.worker.stdin.write(`${JSON.stringify({ id, method, sessionId, ...payload })}\n`)
    })
  }

  async load({ domain, policy, database, taskId, clock } = {}) {
    if (!['retail', 'airline'].includes(domain)) throw new Error('Invalid tau domain')
    if (policy !== undefined && (typeof policy !== 'string' || !policy.trim())) throw new Error('Invalid policy')
    if (database !== undefined && (!database || typeof database !== 'object' || Array.isArray(database))) {
      throw new Error('Invalid database')
    }
    if (clock !== undefined && clock !== '2024-05-15T15:00:00') throw new Error('Only the official tau clock is supported')
    if (taskId !== undefined && typeof taskId !== 'string') throw new Error('Invalid task ID')
    if (this.sessions.size + this.loading >= 20) throw new Error('Release old tau sessions first (limit 20)')
    const sessionId = `tau-${randomUUID()}`
    this.loading += 1
    let loaded
    try { loaded = await this.request('load', sessionId, { domain, policy, database, taskId }) }
    finally { this.loading -= 1 }
    const version = randomUUID()
    this.sessions.set(sessionId, { ...loaded, version, toolset: `tau-${domain}` })
    return { sessionId, version, domain, toolset: `tau-${domain}`, task: loaded.task,
      sourceCommit: loaded.sourceCommit, sourceDirty: loaded.sourceDirty,
      conversationId: `customer-${randomUUID()}` }
  }

  definitions(sessionId, surface) {
    return this.context(sessionId).definitions.filter(tool => surface === 'backend' || tool.annotations.readOnlyHint)
  }

  async execute(sessionId, name, args = {}, surface = 'backend') {
    for (const [token, entry] of this.approvals) {
      if (Date.now() - entry.at >= 300_000) this.approvals.delete(token)
    }
    const context = this.context(sessionId)
    const tool = this.definitions(sessionId, surface).find(tool => tool.name === name)
    if (!tool) throw new Error(`Tool is not available on this tau surface: ${name}`)
    const { approval_token: token, ...operationArgs } = args
    if (tool.annotations.readOnlyHint) {
      const result = await this.request('call', sessionId, { name, args: operationArgs })
      // Only successful official identity tools establish shared identity. Neither
      // model-written objectives nor task/DB fixtures are authentication evidence.
      if (['find_user_id_by_email', 'find_user_id_by_name_zip'].includes(name)) {
        // Official to_json_str returns scalar strings verbatim (not JSON quoted).
        const userId = result.content
        if (typeof userId === 'string' && userId.trim()) {
          if (context.verifiedIdentity && context.verifiedIdentity.userId !== userId) {
            throw new Error('Only one authenticated customer is allowed per conversation')
          }
          context.verifiedIdentity = { userId, method: name, arguments: structuredClone(operationArgs) }
        }
      }
      return result
    }
    if (!token) {
      if (this.approvals.size >= 1_000) throw new Error('Too many pending tau approvals')
      const preview = await this.request('preview', sessionId, { name, args: operationArgs })
      const approval = { token: randomUUID(), preview: `Approval required. NOTHING HAS BEEN EXECUTED.\nProposed operation: ${name}\nParameters: ${JSON.stringify(operationArgs)}\nProposed financial/booking details: ${preview.content}\nDo you explicitly approve this exact operation?` }
      this.approvals.set(approval.token, { sessionId, name, args: structuredClone(operationArgs),
        hash: preview.hash, version: context.version, at: Date.now() })
      return { content: approval.preview, data: { needsApproval: true, approval } }
    }
    const pending = this.approvals.get(token)
    if (!pending || pending.sessionId !== sessionId) throw new Error('Invalid tau approval')
    this.approvals.delete(token)
    if (pending.version !== context.version || pending.name !== name
      || !isDeepStrictEqual(pending.args, operationArgs) || Date.now() - pending.at >= 300_000) {
      throw new Error('Mismatched or expired tau approval')
    }
    const result = await this.request('commit', sessionId, { name, args: operationArgs, hash: pending.hash })
    return { ...result, data: { operationCommitted: true } }
  }

  revoke(sessionId, token) {
    if (this.approvals.get(token)?.sessionId !== sessionId) return false
    return this.approvals.delete(token)
  }

  async snapshot(sessionId) {
    const { domain, version, toolset, sourceCommit, sourceDirty } = this.context(sessionId)
    return { sessionId, domain, version, toolset, sourceCommit, sourceDirty,
      ...await this.request('snapshot', sessionId) }
  }

  async release(sessionId) {
    this.context(sessionId)
    await this.request('delete', sessionId)
    this.sessions.delete(sessionId)
    for (const [token, entry] of this.approvals) if (entry.sessionId === sessionId) this.approvals.delete(token)
    return { ok: true }
  }

  close() { this.closed = true; this.fail(new Error('tau provider closed')) }
}
