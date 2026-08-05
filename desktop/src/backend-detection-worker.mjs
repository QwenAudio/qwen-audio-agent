import { parentPort, workerData } from 'node:worker_threads'

import { inspectBackendSetupsAsync } from '../../shared/backend-setup.mjs'
import { inspectBackendAuthentication } from '../../shared/backend-auth-status.mjs'
import { refreshProcessPath } from './process-path.mjs'

function compactComponent(component) {
  if (!component || typeof component !== 'object') return undefined
  // 组件级就绪状态供一键安装判断“只补缺失组件”（如仅缺 ACP 适配器）。
  return { ready: component.ready === true, source: component.source || '' }
}

function compactReport(report) {
  return {
    selected: report.selected,
    backends: report.backends.map(item => ({
      id: item.id,
      label: item.label,
      ready: item.ready,
      selected: item.selected,
      issues: item.issues,
      backend: compactComponent(item.backend),
      adapter: compactComponent(item.adapter),
      authentication: item.authentication,
    })),
  }
}

try {
  const env = { ...workerData.env }
  refreshProcessPath({
    env,
    platform: workerData.platform,
  })
  const detected = await inspectBackendSetupsAsync({
    env,
    platform: workerData.platform,
  })
  // Some backend CLIs are sizeable Node/Bun processes. Probe them one at a
  // time so opening Settings never creates a short-lived memory spike.
  const authentications = []
  for (const item of detected.backends) {
    authentications.push(item.ready
      ? await inspectBackendAuthentication(item.id, {
          command: item.backend.path,
          env,
          platform: workerData.platform,
        })
      : { status: 'unknown' })
  }
  const report = {
    ...detected,
    backends: detected.backends.map((item, index) => ({
      ...item,
      authentication: authentications[index],
    })),
  }
  parentPort.postMessage({
    ok: true,
    path: env.PATH || '',
    report: compactReport(report),
  })
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: error?.message || String(error),
  })
}
