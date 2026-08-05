// 设置页"安装"按钮的安装编排：并发守卫、脚本确认、进度回调。
// 与 main.mjs 的 IPC 接线分离，依赖全部注入，保证可单元测试；
// 安装逻辑本身复用 shared/backend-install.mjs（与 CLI 同一份）。

import {
  installBackend,
  installSupport,
} from '../../shared/backend-install.mjs'

export function createBackendInstaller({
  env = process.env,
  platform = process.platform,
  install = installBackend,
  confirmScript = async () => false,
} = {}) {
  const pending = new Set()
  const currentEnvironment = () => typeof env === 'function' ? env() : env
  return {
    support(id) {
      return installSupport(id, { env: currentEnvironment(), platform })
    },
    async install(id, { onProgress = () => {}, inspect } = {}) {
      if (pending.has(id)) {
        throw new Error('该后台 Agent 正在安装中，请等待完成')
      }
      pending.add(id)
      try {
        return await install(id, {
          env: currentEnvironment(),
          platform,
          onProgress,
          ...(inspect ? { inspect } : {}),
          confirmStep: step => confirmScript(step),
        })
      } finally {
        pending.delete(id)
      }
    },
  }
}
