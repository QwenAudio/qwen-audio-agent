import { NativeDesktopRuntime } from './native-runtime.mjs'
import { WslRuntimeController } from './wsl-runtime-controller.mjs'

export function createDesktopRuntime({
  platform = process.platform,
  architecture = process.arch,
  dependencies = {},
} = {}) {
  const NativeRuntime = dependencies.NativeRuntime || NativeDesktopRuntime
  const WslRuntime = dependencies.WslRuntime || WslRuntimeController
  if (platform === 'win32') {
    if (architecture !== 'x64') {
      throw new Error('The Windows desktop client requires Windows x64')
    }
    return new WslRuntime(dependencies.windows)
  }
  return new NativeRuntime(dependencies.native)
}
