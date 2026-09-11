import { Worker } from 'node:worker_threads'

const defaultWorkerUrl = new URL('./detection-worker.mjs', import.meta.url)

export function detectBackendSetups({
  env = process.env,
  platform = process.platform,
  pathCacheFile = '',
  WorkerImpl = Worker,
  workerUrl = defaultWorkerUrl,
  timeoutMs = 15_000,
} = {}) {
  return new Promise((resolve, reject) => {
    const worker = new WorkerImpl(workerUrl, {
      workerData: {
        env: { ...env },
        platform,
        pathCacheFile,
      },
    })
    let settled = false

    const timer = setTimeout(() => {
      fail(new Error('后台 Agent 检测超时，请重试'))
      void worker.terminate?.()
    }, timeoutMs)
    const finish = callback => value => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback(value)
    }
    const succeed = finish(message => {
      if (!message?.ok) {
        reject(new Error(message?.error || '后台 Agent 检测失败'))
        return
      }
      resolve({
        path: message.path || '',
        report: message.report,
      })
    })
    const fail = finish(reject)

    worker.once('message', succeed)
    worker.once('error', fail)
    worker.once('exit', code => {
      fail(new Error(
        code === 0
          ? '后台 Agent 检测进程未返回结果'
          : `后台 Agent 检测进程异常退出：${code}`,
      ))
    })
  })
}
