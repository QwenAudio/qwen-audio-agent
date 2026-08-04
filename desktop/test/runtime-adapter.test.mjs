import assert from 'node:assert/strict'
import test from 'node:test'
import { createDesktopRuntime } from '../src/runtime-adapter.mjs'

test('constructs only the native adapter outside Windows', () => {
  const calls = []
  class NativeRuntime {
    constructor(options) {
      calls.push(['native', options])
    }
  }
  class WslRuntime {
    constructor() {
      calls.push(['wsl'])
    }
  }
  const runtime = createDesktopRuntime({
    platform: 'darwin',
    architecture: 'arm64',
    dependencies: {
      NativeRuntime,
      WslRuntime,
      native: { root: '/app' },
      windows: { distribution: 'Ubuntu' },
    },
  })
  assert.equal(runtime instanceof NativeRuntime, true)
  assert.deepEqual(calls, [['native', { root: '/app' }]])
})

test('constructs the WSL controller only for Windows x64', () => {
  const calls = []
  class NativeRuntime {
    constructor() {
      calls.push(['native'])
    }
  }
  class WslRuntime {
    constructor(options) {
      calls.push(['wsl', options])
    }
  }
  const runtime = createDesktopRuntime({
    platform: 'win32',
    architecture: 'x64',
    dependencies: {
      NativeRuntime,
      WslRuntime,
      native: { root: '/app' },
      windows: { distribution: 'Ubuntu' },
    },
  })
  assert.equal(runtime instanceof WslRuntime, true)
  assert.deepEqual(calls, [['wsl', { distribution: 'Ubuntu' }]])
})

test('rejects unsupported Windows architecture before constructing a runtime', () => {
  let constructed = false
  class Runtime {
    constructor() {
      constructed = true
    }
  }
  assert.throws(() => createDesktopRuntime({
    platform: 'win32',
    architecture: 'arm64',
    dependencies: {
      NativeRuntime: Runtime,
      WslRuntime: Runtime,
    },
  }), /Windows x64/i)
  assert.equal(constructed, false)
})
