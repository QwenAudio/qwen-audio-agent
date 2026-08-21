import {
  CommitReceipts,
  ComposerDictation,
  textFingerprint,
} from '../../shared/dictation-contract.mjs'

export function enqueueDictationEvent(queue, item, limit = 64) {
  return [...(Array.isArray(queue) ? queue : []), item].slice(-limit)
}

export class ComposerDictationClient {
  constructor({
    enabled = false,
    canStart = () => false,
    send = () => false,
    submit = () => false,
    onView = () => {},
    setCapture = () => {},
  } = {}) {
    this.enabled = enabled
    this.canStart = canStart
    this.send = send
    this.submit = submit
    this.onView = onView
    this.setCapture = setCapture
    this.model = new ComposerDictation()
    this.receipts = new CommitReceipts()
    this.state = 'idle'
    this.error = ''
    this.notice = ''
    this.active = false
    this.continuous = true
  }

  view() {
    return {
      ...this.model.snapshot(),
      state: this.state,
      error: this.error,
      notice: this.notice,
    }
  }

  publish() { this.onView(this.view()) }

  start(text = '', { continuous = true } = {}) {
    if (!this.enabled || this.active || !this.canStart()) return false
    this.model = new ComposerDictation(text)
    this.continuous = continuous !== false
    this.active = true
    this.error = ''
    this.notice = ''
    this.state = 'starting'
    this.setCapture(true)
    const sent = this.send({
      type: 'dictation.start', text: this.model.text,
      revision: this.model.revision, continuous: this.continuous,
    })
    if (!sent) {
      this.active = false
      this.setCapture(false, { restore: true })
      this.state = 'error'
      this.error = 'Gateway 尚未连接'
    }
    this.publish()
    return sent
  }

  stop(type = 'dictation.stop') {
    if (!this.active) return false
    this.send({ type })
    this.active = false
    this.setCapture(false, { restore: true })
    this.state = type === 'dictation.cancel' ? 'cancelled' : 'stopped'
    this.notice = ''
    this.publish()
    return true
  }

  shortcut(event, text = this.model.text) {
    if (!this.enabled || event?.key?.toLowerCase() !== 'd') return false
    if (!(event.ctrlKey || event.metaKey) || !event.shiftKey) return false
    event.preventDefault?.()
    return this.active ? this.stop() : this.start(text)
  }

  keyboard(text) {
    if (!this.active) {
      this.model = new ComposerDictation(text)
      this.publish()
      return true
    }
    const expectedRevision = this.model.revision
    const previousText = this.model.text
    const pending = this.model.pending
    const editedText = String(text || '')
    const mergedText = pending && editedText.startsWith(previousText)
      ? `${previousText}${pending}${editedText.slice(previousText.length)}`
      : `${editedText}${pending}`
    this.model.keyboardEdit(() => mergedText)
    const snapshot = this.model.snapshot()
    this.send({
      type: 'dictation.context',
      expectedRevision,
      revision: this.model.revision,
      text: this.model.text,
      range: snapshot.range,
    })
    this.publish()
    return true
  }

  manualCommitted() {
    if (!this.active) return false
    const expectedRevision = this.model.revision
    this.model.reset('')
    if (this.continuous) {
      this.send({
        type: 'dictation.reset', expectedRevision,
        revision: this.model.revision,
      })
      this.state = 'listening'
    } else {
      this.send({ type: 'dictation.stop' })
      this.active = false
      this.setCapture(false, { restore: true })
      this.state = 'stopped'
    }
    this.publish()
    return true
  }

  handle(event = {}) {
    if (!this.enabled) return false
    if (event.type === 'input.suspend') {
      this.active = false
      this.setCapture(false, { restore: true })
      this.state = 'stopped'
      this.error = '麦克风已由外部输入占用；恢复后请重新开始听写'
      this.notice = ''
      this.publish()
      return true
    }
    if (event.type === 'dictation.state') {
      const wasActive = this.active
      this.state = String(event.state || 'idle')
      this.error = this.state === 'error' ? String(event.message || '') : ''
      this.notice = String(event.notice || '')
      if (['cancelled', 'error', 'stopped'].includes(this.state)) {
        this.active = false
        if (wasActive) this.setCapture(false, {
          restore: true,
        })
      }
      this.publish()
      return true
    }
    if (!this.active) return false
    if (event.type === 'dictation.partial') {
      const accepted = this.model.partial(event)
      if (accepted) this.publish()
      return accepted
    }
    if (event.type === 'dictation.final') {
      const accepted = this.model.final(event)
      if (accepted) this.publish()
      return accepted
    }
    if (event.type === 'dictation.operation') {
      const accepted = event.operation === 'replace'
        && this.model.replaceRecent(event)
      if (accepted) this.publish()
      return accepted
    }
    if (event.type === 'dictation.commit.request') {
      if (
        Number(event.revision) !== this.model.revision
        || event.fingerprint !== textFingerprint(this.model.text)
        || !this.receipts.accept(event.commitId)
      ) return false
      const memoryOnly = event.intent === 'memory-correction'
      const submitted = memoryOnly ? false : this.submit(this.model.text) === true
      const accepted = memoryOnly || submitted
      this.send({
        type: 'dictation.commit.ack',
        commitId: event.commitId,
        revision: event.revision,
        fingerprint: event.fingerprint,
        submitted,
        ...(memoryOnly ? { accepted: true, intent: event.intent } : {}),
      })
      if (accepted) this.model.reset('')
      else this.error = '内容未提交，请检查 Gateway 连接'
      this.publish()
      return accepted
    }
    return false
  }
}
