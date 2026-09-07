// One stateless chat-completions request against any OpenAI-compatible
// endpoint. Returning null for incomplete configuration lets optional
// background analysis disable itself without affecting the voice runtime.
export function createOpenAiCompatibleTextCall({
  baseUrl,
  apiKey,
  model,
  timeoutMs = 10_000,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!apiKey || !baseUrl || !model) return null
  return async ({ system, user }) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const request = async (includeTemperature) => fetchImpl(
        `${baseUrl}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            ...(includeTemperature ? { temperature: 0 } : {}),
          }),
          signal: controller.signal,
        },
      )
      // Some OpenAI-compatible models reject optional sampling parameters.
      // Retry once with the smallest common request shape; the timeout remains
      // shared so a compatibility retry cannot double the caller's deadline.
      let response = await request(true)
      if (response.status === 400) {
        await response.body?.cancel?.()
        response = await request(false)
      }
      if (!response.ok) {
        const detail = String(await response.text().catch(() => ''))
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 300)
        throw new Error(
          `text model request failed: ${response.status}${detail ? ` ${detail}` : ''}`,
        )
      }
      const payload = await response.json()
      return String(payload?.choices?.[0]?.message?.content || '')
    } finally {
      clearTimeout(timer)
    }
  }
}
