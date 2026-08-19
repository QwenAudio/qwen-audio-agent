const SYSTEM_PROMPT = 'Rewrite only the supplied draft. Return only rewritten text.'

export function createStatelessRewriter({
  baseUrl,
  apiKey,
  model,
  fetchImpl = fetch,
  timeoutMs = 15_000,
} = {}) {
  const endpoint = `${String(baseUrl || '').replace(/\/+$/, '')}/chat/completions`
  return async (draft, instruction) => {
    if (!baseUrl || !apiKey || !model) {
      throw new Error('Stateless rewrite is not configured')
    }
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Instruction:\n${String(instruction || '')}\n\nDraft:\n${String(draft || '')}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) {
      throw new Error(`Rewrite provider temporarily unavailable (${response.status})`)
    }
    const payload = await response.json()
    const text = String(payload?.choices?.[0]?.message?.content || '').trim()
    if (!text) throw new Error('Rewrite provider returned an empty rewrite')
    return text
  }
}
