import { parentPort, workerData } from 'node:worker_threads'
import { createSherpaWakeWordDetector } from './sherpa-detector.mjs'

let detector = null

createSherpaWakeWordDetector({ modelRoot: workerData.modelRoot })
  .then(value => {
    detector = value
    parentPort.postMessage({ type: 'ready' })
  })
  .catch(error => parentPort.postMessage({
    type: 'error',
    message: error?.message || String(error),
  }))

parentPort.on('message', message => {
  if (!detector || message?.type !== 'audio') return
  try {
    if (detector.accept(message.audio, message.sampleRate)) {
      parentPort.postMessage({ type: 'detected' })
    }
  } catch (error) {
    parentPort.postMessage({
      type: 'error',
      message: error?.message || String(error),
    })
  }
})
