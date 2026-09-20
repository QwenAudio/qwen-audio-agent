import { resolve } from 'node:path'
import { MemcodeClient } from 'memcode-sdk'
import { createGatewayApplication } from '../../server/src/app/gateway-application.mjs'
import { MemcodeMemoryProvider } from './provider.mjs'

function required(name) {
  const value = String(process.env[name] || '').trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

const ownerId = process.env.QWEN_AUDIO_AGENT_PERSONAL_OWNER_ID || 'user_personal'
const client = new MemcodeClient(
  process.env.MEMCODE_API_URL || 'https://memory.memcode.in',
  required('MEMCODE_API_KEY'),
)
const memoryProvider = new MemcodeMemoryProvider({
  client,
  ownerId,
  stateFile: resolve('.qwen-audio', 'runtime', 'memory', 'memcode', 'snapshot.json'),
})

const gateway = createGatewayApplication({ memoryProvider })

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await gateway.close()
    process.exit(0)
  })
}
