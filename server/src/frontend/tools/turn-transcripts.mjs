export class TurnTranscripts {
  constructor({ waitMs = 800, maxTurns = 20 } = {}) {
    this.waitMs = waitMs
    this.maxTurns = maxTurns
    this.values = new Map()
    this.waiters = new Map()
    this.inputParts = new Map()
  }

  record(turnId, transcript) {
    if (!turnId) return
    const content = String(transcript || '').trim()
    this.values.set(turnId, content)
    while (this.values.size > this.maxTurns) {
      this.values.delete(this.values.keys().next().value)
    }
    const waiters = this.waiters.get(turnId) || []
    this.waiters.delete(turnId)
    waiters.forEach(resolve => resolve(content))
  }

  recordParts(turnId, parts = []) {
    if (!turnId) return
    const value = Array.isArray(parts) ? parts.map(part => ({ ...part })) : []
    if (value.length) this.inputParts.set(turnId, value)
    else this.inputParts.delete(turnId)
    while (this.inputParts.size > this.maxTurns) {
      this.inputParts.delete(this.inputParts.keys().next().value)
    }
  }

  parts(turnId) {
    return (this.inputParts.get(turnId) || []).map(part => ({ ...part }))
  }

  async transcript(turnId) {
    if (this.values.has(turnId)) return this.values.get(turnId)
    return new Promise(resolve => {
      const waiters = this.waiters.get(turnId) || []
      let settled = false
      const finish = value => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      }
      waiters.push(finish)
      this.waiters.set(turnId, waiters)
      const timer = setTimeout(() => {
        const pending = this.waiters.get(turnId) || []
        const index = pending.indexOf(finish)
        if (index >= 0) pending.splice(index, 1)
        if (pending.length) this.waiters.set(turnId, pending)
        else this.waiters.delete(turnId)
        finish('')
      }, this.waitMs)
    })
  }

  async resolveDelegation(turnId, suppliedObjective) {
    const objective = String(suppliedObjective || '').replace(/\s+/g, ' ').trim()
    const transcript = await this.transcript(turnId)
    const originalRequest = String(transcript || objective).replace(/\s+/g, ' ').trim()
    return {
      originalRequest,
      objective: objective || originalRequest,
      ...(this.parts(turnId).length ? { inputParts: this.parts(turnId) } : {}),
    }
  }

  close() {
    this.waiters.forEach(waiters => waiters.forEach(resolve => resolve('')))
    this.waiters.clear()
    this.inputParts.clear()
  }
}
