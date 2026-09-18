import { blobToBase64, cameraFrameSize, captureCameraFrame, encodeCameraCanvas,
  stopCameraStream } from '../../../web/src/composer/camera-input.js'

export class VisualCapture {
  constructor(video, onChange = () => {}) {
    Object.assign(this, { video, onChange, stream: null, bitmap: null, source: 'none', generation: crypto.randomUUID() })
  }
  state() { return { source: this.source, active: this.source !== 'none', generation: this.generation } }
  stop() {
    this.generation = crypto.randomUUID()
    const stream = this.stream
    this.stream = null
    stopCameraStream(stream)
    this.video.srcObject = null
    this.bitmap?.close()
    this.bitmap = null
    this.source = 'none'
    this.onChange(this.state())
  }
  async open(source) {
    this.stop()
    const generation = this.generation
    const stream = source === 'screen'
      ? await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
      : await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
    if (generation !== this.generation) { stopCameraStream(stream); return }
    this.stream = stream
    this.source = source
    this.video.srcObject = stream
    stream.getVideoTracks().forEach(track => track.addEventListener('ended', () => {
      if (this.stream === stream) this.stop()
    }, { once: true }))
    try { await this.video.play() }
    catch (error) { if (this.stream === stream) this.stop(); throw error }
    if (generation !== this.generation) return
    this.onChange(this.state())
  }
  async openFile(file) {
    if (!file || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) {
      throw new Error('请选择不超过 10 MiB 的 PNG、JPEG 或 WebP 图片')
    }
    this.stop()
    const generation = this.generation
    const bitmap = await createImageBitmap(file)
    if (generation !== this.generation) { bitmap.close(); return }
    this.bitmap = bitmap
    this.source = 'image'
    this.onChange(this.state())
  }
  async capture() {
    const { source, generation } = this
    if (source === 'none') throw new Error('请先选择并授权摄像头、屏幕或图片')
    let blob
    if (this.bitmap) {
      const size = cameraFrameSize(this.bitmap.width, this.bitmap.height)
      const canvas = document.createElement('canvas')
      Object.assign(canvas, size)
      canvas.getContext('2d').drawImage(this.bitmap, 0, 0, size.width, size.height)
      blob = await encodeCameraCanvas(canvas)
    } else blob = await captureCameraFrame(this.video)
    const image = await blobToBase64(blob)
    if (generation !== this.generation) throw new Error('视觉来源已切换，请重试')
    return { source, generation, capturedAt: Date.now(), image }
  }
}
