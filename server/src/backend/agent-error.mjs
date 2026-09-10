export class AgentError extends Error {
  constructor(message, { status = 0, body = '', protocol = '' } = {}) {
    super(message)
    this.name = 'AgentError'
    this.status = status
    this.body = body
    this.protocol = protocol
  }
}
