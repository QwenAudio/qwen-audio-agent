// The driver is the Web demo's fixed wake zone on the central Realtime.
// Other seats contribute recognized text without taking over its audio input.
// A lone driver keeps native Smart Turn; simulated text opens a shared batch.
export class CockpitSmartTurn {
  constructor({ coordinator, publish, timeoutMs = 15_000 }) {
    Object.assign(this, { coordinator, publish, timeoutMs })
    this.items = new Map()
    this.responses = new Set()
    this.waiters = new Set()
    this.closed = false
  }

  join(item) {
    this.coordinator.start('driver', item.id)
    if (item.ended) this.coordinator.end('driver', item.id)
    if (item.final) this.coordinator.final('driver', item.id, item.text)
  }

  text(rows, id) {
    for (const item of this.items.values()) if (item.pending) this.join(item)
    this.coordinator.text(rows, id)
  }

  receive(event) {
    if (this.closed) return
    if (event.type === 'session.disconnected') {
      this.coordinator.fail('主驾 Smart Turn 连接中断，请重新发送本轮输入')
      this.items.clear()
      this.responses.clear()
      for (const done of this.waiters) done(new Error('Smart Turn 连接中断'))
      this.publish()
      return
    }
    if (!event.type.startsWith('input_audio_buffer.speech_')
      && !event.type.startsWith('conversation.item.input_audio_transcription.')
      && !['response.created', 'response.done'].includes(event.type)) return
    const key = event.item_id
    if (event.type === 'input_audio_buffer.speech_started') {
      const item = { id: key, pending: true, ended: false, final: false, text: '' }
      this.items.set(key, item)
      if (this.coordinator.batch) this.join(item)
    }
    const item = this.items.get(key)
    if (item) {
      if (event.type === 'input_audio_buffer.speech_stopped') {
        item.ended = true
        if (event.reason === 'turn_invalid') {
          item.pending = false
          this.coordinator.discard('driver', item.id)
          this.items.delete(key)
        } else this.coordinator.end('driver', item.id)
      } else if (event.type === 'conversation.item.input_audio_transcription.completed') {
        item.final = true
        item.text = String(event.transcript || '')
        this.lastText = item.text
        this.coordinator.final('driver', item.id, item.text)
      } else if (['conversation.item.input_audio_transcription.text', 'conversation.item.input_audio_transcription.delta'].includes(event.type)) {
        this.coordinator.partial('driver', item.id, event.text || event.delta || '')
      } else if (event.type === 'conversation.item.input_audio_transcription.failed') {
        item.failed = true
        if (this.coordinator.batch?.entries.some(entry => entry.zone === 'driver' && entry.id === item.id)) {
          this.coordinator.fail('主驾识别失败，请重新发送本轮输入')
        }
      }
    }
    if (event.type === 'response.created' && !event.__voiceContext?.turnId) {
      const id = event.response?.id || event.response_id
      for (const current of this.items.values()) {
        if (!current.ended || !current.pending) continue
        current.pending = false
        // During collection the framework cancels this automatic response.
        if (this.coordinator.batch?.entries.some(entry => entry.id === current.id && entry.zone === 'driver')) {
          this.responses.add(id)
        } else this.items.delete(current.id)
      }
    }
    if (event.type === 'response.done') {
      this.responses.delete(event.response?.id || event.response_id)
      for (const current of this.items.values()) {
        if (!current.pending && current.ended && (current.final || current.failed)) this.items.delete(current.id)
      }
    }
    if (!this.busy()) for (const done of this.waiters) done()
    this.publish()
  }

  busy() { return this.responses.size > 0 || [...this.items.values()].some(item => item.pending) }

  waitForIdle() {
    if (!this.busy()) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const done = error => {
        clearTimeout(timer)
        this.waiters.delete(done)
        if (error) reject(error)
        else resolve()
      }
      const timer = setTimeout(() => done(new Error('等待主驾 Smart Turn 或自动回复取消确认超时')), this.timeoutMs)
      timer.unref?.()
      this.waiters.add(done)
    })
  }

  close() {
    this.closed = true
    for (const done of this.waiters) done(new Error('Smart Turn 收集已关闭'))
    this.items.clear()
    this.responses.clear()
  }
}
