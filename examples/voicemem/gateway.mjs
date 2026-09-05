import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = dirname(fileURLToPath(import.meta.url))
const localPython = resolve(
  directory,
  '.venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
)

// The example is ordinary Gateway configuration: the Provider implementation
// is shipped by qwen-audio-agent rather than copied into this directory.
process.env.QWEN_AUDIO_MEMORY_PROVIDER ||= 'voicemem'
if (!process.env.VOICEMEM_PYTHON && existsSync(localPython)) {
  process.env.VOICEMEM_PYTHON = localPython
}
process.env.VOICEMEM_SIDECAR ||= resolve(directory, 'sidecar', 'server.py')

const { createGatewayApplication } = await import(
  'qwen-audio-agent/gateway-application'
)
const gateway = createGatewayApplication()

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await gateway.close()
    process.exit(0)
  })
}
