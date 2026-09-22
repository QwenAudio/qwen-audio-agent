import { resolve } from 'node:path'
import { MemcodeClient } from 'memcode-sdk'
import { MemcodeMemoryProvider, memcodeBinding } from './provider.mjs'

function required(name) {
  const value = String(process.env[name] || '').trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

const ownerId = process.env.QWEN_AUDIO_AGENT_PERSONAL_OWNER_ID || 'user_personal'
const apiUrl = process.env.MEMCODE_API_URL || 'https://memory.memcode.in'
const apiKey = required('MEMCODE_API_KEY')
const binding = memcodeBinding(apiUrl, apiKey)
const client = new MemcodeClient(apiUrl, apiKey)
const memoryProvider = new MemcodeMemoryProvider({
  client,
  binding,
  ownerId,
  stateFile: resolve(process.env.QWAUDIO_CONFIG_DIR || '.qwen-audio/runtime', 'memory', 'memcode', 'snapshot.json'),
})

// This example only supports explicit edits. Set before importing Gateway config.
process.env.QWEN_AUDIO_MEMORY_AUTO = 'off'
process.env.QWEN_AUDIO_PREFERENCE_LEARNING = 'off'
const { createGatewayApplication } = await import('qwen-audio-agent/gateway-application')
const gateway = createGatewayApplication({ memoryProvider })

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await gateway.close()
    process.exit(0)
  })
}
