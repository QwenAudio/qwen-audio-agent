import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

// Scenario provider used only by the EVA text harness bridge. Business tools
// and state stay in EVA's Python ToolExecutor; this adapter exposes them through
// the demo's real frontend/backend MCP surfaces and deterministic approval path.
export class EvaScenarios {
  constructor({ origin, token, sessionId, policy, definitions, currentDateTime } = {}) {
    if (!origin || !token || !sessionId) throw new TypeError('EVA scenario bridge configuration is incomplete')
    this.origin = origin
    this.token = token
    this.sessionId = sessionId
    this.approvals = new Map()
    this.session = {
      domain: 'airline', policy, definitions, currentDateTime,
      version: randomUUID(), toolset: 'benchmark-eva-airline',
      conversationId: sessionId,
    }
  }

  owns(sessionId) { return sessionId === this.sessionId }

  context(sessionId) {
    if (!this.owns(sessionId)) throw new Error('Unknown EVA harness session')
    return this.session
  }

  definitions(sessionId, surface) {
    const definitions = this.context(sessionId).definitions
    return definitions.filter(tool => surface === 'backend' || tool.annotations?.readOnlyHint)
  }

  async #request(action, name, args, hash) {
    const response = await fetch(new URL('/harness/tool', this.origin), {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, name, args, hash }),
      signal: AbortSignal.timeout(180_000),
    })
    const body = await response.json()
    if (!response.ok) throw new Error(body.error || `EVA tool bridge failed (${response.status})`)
    return body
  }

  async execute(sessionId, name, args = {}, surface = 'backend') {
    for (const [token, entry] of this.approvals) {
      if (Date.now() - entry.at >= 300_000) this.approvals.delete(token)
    }
    const tool = this.definitions(sessionId, surface).find(candidate => candidate.name === name)
    if (!tool) throw new Error(`Tool is not available on this EVA ${surface} surface: ${name}`)
    const { approval_token: token, ...operationArgs } = args
    if (tool.annotations?.readOnlyHint) {
      const result = await this.#request('execute', name, operationArgs)
      return { content: JSON.stringify(result.result), data: { changed: false } }
    }
    if (!token) {
      const preview = await this.#request('preview', name, operationArgs)
      const approval = {
        token: randomUUID(),
        preview: [
          'Approval required. NOTHING HAS BEEN EXECUTED.',
          `Proposed operation: ${name}`,
          `Parameters: ${JSON.stringify(operationArgs)}`,
          `Proposed result: ${JSON.stringify(preview.result)}`,
          'Do you explicitly approve this exact operation?',
        ].join('\n'),
      }
      this.approvals.set(approval.token, {
        sessionId, name, args: structuredClone(operationArgs), hash: preview.hash,
        version: this.session.version, at: Date.now(),
      })
      return { content: approval.preview, data: { needsApproval: true, approval } }
    }
    const pending = this.approvals.get(token)
    if (!pending || pending.sessionId !== sessionId) throw new Error('Invalid EVA approval')
    this.approvals.delete(token)
    if (pending.version !== this.session.version || pending.name !== name
      || !isDeepStrictEqual(pending.args, operationArgs) || Date.now() - pending.at >= 300_000) {
      throw new Error('Mismatched or expired EVA approval')
    }
    const result = await this.#request('commit', name, operationArgs, pending.hash)
    return { content: JSON.stringify(result.result), data: { operationCommitted: true, changed: true } }
  }

  revoke(sessionId, token) {
    if (!this.owns(sessionId) || this.approvals.get(token)?.sessionId !== sessionId) return false
    return this.approvals.delete(token)
  }

  close() { this.approvals.clear() }
}
