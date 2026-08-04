import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { DesktopHostGateway } from '../src/desktop-host-gateway.mjs'

const gatewayEntry = fileURLToPath(new URL(
  '../../server/src/index.mjs',
  import.meta.url,
))

test('forks a real port-zero Gateway and releases its process group', {
  skip: process.platform === 'win32',
  timeout: 20_000,
}, async () => {
  const configDirectory = await mkdtemp(join(
    tmpdir(),
    'qwaudio-desktop-host-gateway-',
  ))
  const gateway = new DesktopHostGateway({
    entryPath: gatewayEntry,
    environment: {
      ...process.env,
      QWAUDIO_CONFIG_DIR: configDirectory,
      AGENT_PROTOCOL: 'none',
      DASHSCOPE_API_KEY: '',
      QWEN_AUDIO_AGENT_DESKTOP: '1',
      QWEN_AUDIO_AGENT_DESKTOP_INSTALLED_ONLY: '1',
    },
    startupTimeoutMs: 10_000,
    stopTimeoutMs: 3_000,
  })

  let processGroupId
  try {
    const origin = await gateway.start()
    processGroupId = gateway.child.pid
    assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/)
    const response = await fetch(`${origin}/api/health`)
    assert.equal(response.status, 200)
    assert.equal((await response.json()).ok, true)
  } finally {
    await gateway.stop()
    await rm(configDirectory, { recursive: true, force: true })
  }

  assert.throws(
    () => process.kill(processGroupId, 0),
    error => error?.code === 'ESRCH',
  )
})
