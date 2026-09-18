// Native tau2 LLMAgent: no frontend, A2A, approval classifier or demo runtime.
export async function createMaxOnly({ scenarios, sessionId, model, baseURL, signal }) {
  await scenarios.request('agent-init', sessionId, { model, baseURL })
  let modelCalls = 0, toolCalls = 0
  return {
    async turn(content) {
      for (let round = 0; round < 100; round += 1) {
        signal.throwIfAborted()
        const reply = await scenarios.request('agent-step', sessionId, round ? {} : { content })
        modelCalls += 1
        toolCalls += reply.toolCalls
        if (!reply.toolCalls) return reply.content
      }
      throw new Error('Max-only exceeded 100 model rounds in one user turn')
    },
    counts: () => ({ agentModelCalls: modelCalls, directToolCalls: toolCalls }),
    async close() {},
  }
}
