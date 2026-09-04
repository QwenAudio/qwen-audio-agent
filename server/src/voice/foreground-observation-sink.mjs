export class ForegroundObservationSink {
  constructor({
    ensureFrontend,
    getFrontend,
    onError,
  } = {}) {
    this.ensureFrontend = ensureFrontend
    this.getFrontend = getFrontend
    this.onError = onError
    this.frontend = null
    this.active = false
    this.unavailable = false
  }

  async prepare() {
    await this.ensureFrontend?.()
    const frontend = this.getFrontend?.()
    if (!frontend || frontend.transportCapabilities?.observationInput !== true) {
      throw new Error('当前 Realtime 模型不支持画面观察')
    }
    if (typeof frontend.send !== 'function') {
      throw new Error('Realtime 前台不支持画面观察传输')
    }
    this.frontend = frontend
    this.active = true
    this.unavailable = false
    return true
  }

  forward({ image } = {}) {
    if (!this.active) return false
    const frontend = this.getFrontend?.() || this.frontend
    if (!frontend || frontend.transportCapabilities?.observationInput !== true) {
      this.active = false
      this.unavailable = true
      this.onError?.(new Error('画面观察的 Realtime 连接不可用'))
      return false
    }
    if (typeof frontend.send !== 'function') {
      this.active = false
      this.unavailable = true
      this.onError?.(new Error('Realtime 前台不支持画面观察传输'))
      return false
    }

    try {
      // DashScope Qwen-Omni WebSocket input contract. This sink never emits
      // response.create; the next user turn consumes the image context.
      const payload = typeof frontend.protocol?.imageAppend === 'function'
        ? frontend.protocol.imageAppend(image)
        : {
            type: 'input_image_buffer.append',
            image,
          }
      frontend.send(payload)
      return true
    } catch (error) {
      this.onError?.(error)
      return false
    }
  }

  stop() {
    this.active = false
    this.frontend = null
    this.unavailable = false
  }
}
