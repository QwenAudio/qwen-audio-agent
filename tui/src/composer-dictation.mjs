import {
  CommitReceipts,
  ComposerDictation,
  textFingerprint,
} from '../../shared/dictation-contract.mjs'

export class TuiComposerDictation {
  constructor({
    enabled = false,
    canStart = () => false,
    send = () => false,
    submit = async () => false,
    setCapture = () => {},
    onView = () => {},
  } = {}) {
    this.enabled = enabled
    this.canStart = canStart
    this.send = send
    this.submit = submit
    this.setCapture = setCapture
    this.onView = onView
    this.model = new ComposerDictation()
    this.receipts = new CommitReceipts()
    this.active = false
    this.continuous = true
    this.state = 'idle'
    this.error = ''
    this.contextBaseRevision = null
  }

  view() {
    return { ...this.model.snapshot(), state: this.state, error: this.error }
  }

  publish() { this.onView(this.view()) }

  start(text = '', { continuous = true } = {}) {
    if (!this.enabled || this.active || !this.canStart()) return false
    this.model = new ComposerDictation(text)
    this.continuous = continuous !== false
    this.active = true
    this.state = 'starting'
    this.error = ''
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

  settleForKeyboard() {
    if (!this.active || !this.model.pending) return this.model.text
    this.contextBaseRevision = this.model.revision
    this.model.settlePartial()
    this.publish()
    return this.model.text
  }

  keyboard(text) {
    if (!this.active) return false
    const expectedRevision = this.contextBaseRevision ?? this.model.revision
    this.contextBaseRevision = null
    this.model.keyboardEdit(() => String(text || ''))
    this.send({
      type: 'dictation.context', expectedRevision,
      revision: this.model.revision, text: this.model.text,
    })
    this.publish()
    return true
  }

  async manualCommitted() {
    if (!this.active) return false
    this.send({ type: 'dictation.stop' })
    this.model.reset('')
    if (this.continuous && this.canStart()) {
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

  async handle(event = {}) {
    if (!this.enabled) return false
    if (event.type === 'input.suspend') {
      if (this.active) this.send({ type: 'input.suspend.ack', owner: event.owner })
      this.active = false
      this.setCapture(false, { restore: false })
      this.state = 'stopped'
      this.error = '外部输入占用麦克风；恢复后请重新开始听写'
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
      const submitted = await this.submit(this.model.text) === true
      this.send({
        type: 'dictation.commit.ack', commitId: event.commitId,
        revision: event.revision, fingerprint: event.fingerprint, submitted,
      })
      if (submitted) this.model.reset('')
      else this.error = '内容未提交，请检查 Gateway 连接'
      this.publish()
      return submitted
    }
    return false
  }
}
