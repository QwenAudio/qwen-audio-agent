import { normalizeAcpPrompt } from './content.mjs'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  promise.catch(() => {})
  return { promise, resolve, reject }
}

export function updateError(code, message) {
  return Object.assign(new Error(message), { code })
}

function bounded(promise, milliseconds) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(updateError(
        'update_unconfirmed', '后台尚未确认结束当前执行，未发送新的执行请求。',
      )), milliseconds)
    }),
  ]).finally(() => clearTimeout(timer))
}

/** One ACP prompt lifetime, including safe same-Session restarts. No Task or UI policy. */
export class AcpTurnUpdates {
  constructor({ client, sessionId, signal, cancelTimeoutMs = 15_000, onRestart = () => {},
    preparePrompt = prompt => ({ prompt, acknowledge() {} }) }) {
    Object.assign(this, { client, sessionId, signal, cancelTimeoutMs, onRestart, preparePrompt })
    this.pending = []
    this.wake = deferred()
    this.closed = false
    this.hasUpdates = false
  }

  enqueue(prompt, { context } = {}) {
    if (this.closed || this.signal?.aborted) throw updateError('task_not_running', '当前执行已结束。')
    const entry = { prompt: normalizeAcpPrompt(prompt), context, ...deferred() }
    this.hasUpdates = true
    this.pending.push(entry)
    this.wake.resolve()
    return { completion: entry.promise }
  }

  take() {
    this.wake = deferred()
    return this.pending.splice(0)
  }

  // The Agent invokes this extension from its loop, not through an LLM tool.
  drain() {
    if (this.closed || this.signal?.aborted) return { items: [], hasQueuedPrompt: false }
    const entries = this.take()
    if (!entries.length) return { items: [], hasQueuedPrompt: false }
    try {
      // One pull boundary is one delivery: merge its context snapshots under
      // the shared budget without truncating any of the update ContentBlocks.
      const delivery = this.preparePrompt(
        entries.flatMap(entry => entry.prompt), entries.map(entry => entry.context),
      )
      delivery.acknowledge()
      entries.forEach(entry => entry.resolve({ status: 'delivered' }))
      return { items: [{ content: delivery.prompt }], hasQueuedPrompt: false }
    } catch (error) {
      entries.forEach(entry => entry.reject(error))
      throw error
    }
  }

  followup(entries) {
    return [
      { type: 'text', text: '用户更新了当前工作的要求。请结合已有上下文和已执行的操作，按以下新要求继续：' },
      ...entries.flatMap(entry => entry.prompt),
    ]
  }

  async run(initialPrompt, options = {}) {
    let inFlightEntries = this.take()
    let prompt = inFlightEntries.length
      ? [...normalizeAcpPrompt(initialPrompt), ...this.followup(inFlightEntries)]
      : initialPrompt
    let activeExecution
    let settled = true
    try {
      while (true) {
        this.signal?.throwIfAborted()
        settled = false
        const submitted = inFlightEntries
        inFlightEntries = []
        const delivery = this.preparePrompt(prompt, submitted.map(entry => entry.context))
        const acknowledge = () => {
          delivery.acknowledge()
          submitted.forEach(entry => entry.resolve({ status: 'delivered' }))
        }
        const execution = this.client.prompt(this.sessionId, delivery.prompt, {
          ...options, signal: this.signal, timeoutMs: 0,
          onUpdate: update => { acknowledge(); options.onUpdate?.(update) },
          onMidTurnDrain: () => this.drain(),
        }).then(result => {
          acknowledge()
          return { result }
        }, error => {
          submitted.forEach(entry => entry.reject(error))
          return { error }
        }).then(outcome => {
          settled = true
          return outcome
        })
        activeExecution = execution
        let restart = false
        while (true) {
          const outcome = await Promise.race([
            execution,
            this.wake.promise.then(() => ({ update: true })),
          ])
          // A local abort does not prove the remote prompt stopped. Preserve
          // the client's uncertainty so the adapter can quarantine this Session.
          if (outcome.error?.contextUncertain) throw outcome.error
          this.signal?.throwIfAborted()
          if (!outcome.update) {
            if (outcome.error) throw outcome.error
            if (!this.pending.length) return outcome.result
            inFlightEntries = this.take()
            prompt = this.followup(inFlightEntries)
            restart = true
            break
          }
          const mode = this.client.steeringMode?.(this.sessionId) || 'restart'
          let promptRequired = false
          if (mode === 'pull' && !settled) {
            // Leave the entries for the Agent's next boundary. Reset only the wakeup.
            this.wake = deferred()
            continue
          }
          if (mode === 'extension' && !settled) {
            inFlightEntries = this.take()
            const delivery = this.preparePrompt(this.followup(inFlightEntries), inFlightEntries.map(entry => entry.context))
            const reply = await this.client.steerSession(this.sessionId, delivery.prompt, { signal: this.signal })
            if (reply?.outcome === 'injected') {
              delivery.acknowledge()
              inFlightEntries.forEach(entry => entry.resolve({ status: 'delivered' }))
              inFlightEntries = []
              continue
            }
            if (reply?.outcome !== 'promptRequired') {
              // In particular, startedNewTurn may already be running remotely. Never replay it.
              throw Object.assign(updateError('update_unconfirmed', '后台调整投递结果无法确认；没有自动重发。'), {
                contextUncertain: true,
              })
            }
            promptRequired = true
          }
          if (!settled && !promptRequired) {
            await bounded(this.client.cancelSession(this.sessionId), this.cancelTimeoutMs)
          }
          const stopped = await bounded(execution, this.cancelTimeoutMs)
          if (stopped.error) throw stopped.error
          inFlightEntries.push(...this.take())
          await this.onRestart()
          prompt = this.followup(inFlightEntries)
          restart = true
          break
        }
        if (!restart) throw new Error('Unreachable ACP update state')
      }
    } catch (error) {
      inFlightEntries.forEach(entry => entry.reject(error))
      // Never allow generic prompt retries to replay an ambiguously delivered update.
      if (this.hasUpdates) error.updateDeliveryFailed = true
      if (this.hasUpdates && (!settled || error.contextUncertain)) {
        try {
          await bounded(this.client.cancelSession(this.sessionId), this.cancelTimeoutMs)
          if (!settled) await bounded(activeExecution, this.cancelTimeoutMs)
        } catch {
          error.contextUncertain = true
        }
      }
      throw error
    } finally {
      this.closed = true
      const error = updateError('update_not_delivered', '执行已结束，追加要求未投递。')
      this.take().forEach(entry => entry.reject(error))
    }
  }
}
