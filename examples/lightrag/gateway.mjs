// This example embeds the normal Gateway and replaces only its knowledge
// provider. LightRAG remains an independently installed and managed service.
process.env.AGENT_PROTOCOL ||= 'none'

const [{ createGatewayApplication }, { createLightRagKnowledgeProviderFromEnv }] = await Promise.all([
  import('qwen-audio-agent/gateway-application'),
  import('./lightrag-provider.mjs'),
])

const provider = createLightRagKnowledgeProviderFromEnv()
const gateway = createGatewayApplication({
  knowledgeProvider: provider,
  knowledgeRuntimeOptions: {
    timeoutMs: Number(process.env.LIGHTRAG_RETRIEVAL_TIMEOUT_MS) || 60_000,
  },
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await gateway.close()
    process.exit(0)
  })
}
