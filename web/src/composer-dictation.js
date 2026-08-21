import {
  CommitReceipts,
  ComposerDictation,
  textFingerprint,
} from '../../shared/dictation-contract.mjs'

export class ComposerDictationClient {
  constructor({
    enabled = false,
    send = () => false,
    submit = () => false,
    onView = () => {},
    setCapture = () => {},
  } = {}) {
    this.enabled = enabled
    this.send = send
    this.submit = submit
    this.onView = onView
    this.setCapture = setCapture
    this.model = new ComposerDictation()
    this.receipts = new CommitReceipts()
    this.state = 'idle'
    this.error = ''
    this.active = false
    this.continuous = true
  }

  view() {
    return { ...this.model.snapshot(), state: this.state, error: this.error }
  }

  publish() { this.onView(this.view()) }

  start(text = '', { continuous = true } = {}) {
    if (!this.enabled || this.active) return false
    this.model = new ComposerDictation(text)
    this.continuous = continuous !== false
    this.active = true
    this.error = ''
    this.state = 'starting'
    this.setCapture(true)
    const sent = this.send({
      type: 'dictation.start', text: this.model.text,
      revision: this.model.revision, continuous: this.continuous,
    })
    if (!sent) {
      this.active = false
      this.setCapture(false)
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
    this.setCapture(false, { restore: type === 'dictation.stop' })
    this.state = type === 'dictation.cancel' ? 'cancelled' : 'stopped'
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
    this.model.keyboardEdit(() => String(text || ''))
    this.send({
      type: 'dictation.context',
      expectedRevision,
      revision: this.model.revision,
      text: this.model.text,
    })
    this.publish()
    return true
  }

  manualCommitted() {
    if (!this.active) return false
    this.send({ type: 'dictation.stop' })
    this.model.reset('')
    if (this.continuous) {
      this.send({
        type: 'dictation.start', text: '', revision: this.model.revision,
        continuous: true,
      })
      this.state = 'starting'
    } else {
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
      this.setCapture(false, { restore: false })
      this.state = 'stopped'
      this.error = '麦克风已由外部输入占用；恢复后请重新开始听写'
      this.publish()
      return true
    }
    if (event.type === 'dictation.state') {
      const wasActive = this.active
      this.state = String(event.state || 'idle')
      this.error = String(event.message || '')
      if (['cancelled', 'error', 'stopped'].includes(this.state)) {
        this.active = false
        if (wasActive) this.setCapture(false, {
          restore: this.state === 'stopped' && event.reason !== 'input.suspend',
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
      const submitted = this.submit(this.model.text) === true
      this.send({
        type: 'dictation.commit.ack',
        commitId: event.commitId,
        revision: event.revision,
        fingerprint: event.fingerprint,
        submitted,
      })
      if (submitted) this.model.reset('')
      else this.error = '内容未提交，请检查 Gateway 连接'
      this.publish()
      return submitted
    }
    return false
  }
}
