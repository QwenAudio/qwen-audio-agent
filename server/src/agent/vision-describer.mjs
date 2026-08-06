// Describing an image with a model of its own.
//
// ACP has no concept of a model: the SDK's 1833 lines of types mention one only
// in prose, and there is no session/set_model. A Session runs on whatever model
// the Agent was started with, for its whole life. So the only way to keep the
// Agent on a strong text model while still being able to look at something is
// to ask a second model directly, and hand the Agent words instead of pixels.
//
// This is optional. Without QWEN_AUDIO_AGENT_VISION_MODEL the Agent's own model
// receives the image, which is simpler and lets it act on what it sees.
const DEFAULT_PROMPT = [
  '请客观描述这张图片的内容。如果图中有文字、错误信息、代码或界面元素，',
  '请准确转述，不要推测或补充图中没有的信息。',
].join('')

export function visionDescriberAvailable({ visionModel, apiKey } = {}) {
  return Boolean(String(visionModel || '').trim() && String(apiKey || '').trim())
}

export async function describeImage(image, {
  visionModel,
  visionModelUrl,
  apiKey,
  question = '',
  timeoutMs = 120_000,
  fetchImpl = fetch,
} = {}) {
  const model = String(visionModel || '').trim()
  if (!model) throw new Error('未配置视觉模型。')
  if (!String(apiKey || '').trim()) {
    throw new Error('视觉模型缺少 API Key。')
  }
  if (!image?.base64 || !image?.mimeType) {
    throw new Error('图片数据不完整。')
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    // chat/completions rather than /v1/responses: every Bailian multimodal
    // model is served only on the former, and answers "Unsupported model" on
    // the latter.
    const response = await fetchImpl(
      `${String(visionModelUrl || '').replace(/\/+$/, '')}/chat/completions`,
      {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${String(apiKey).trim()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: 800,
          messages: [{
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: { url: `data:${image.mimeType};base64,${image.base64}` },
              },
              {
                type: 'text',
                text: String(question || '').trim() || DEFAULT_PROMPT,
              },
            ],
          }],
        }),
      },
    )
    const payload = await response.json().catch(() => null)
    if (payload?.error) {
      throw new Error(
        `视觉模型 ${model} 调用失败：${payload.error.message || payload.error}`,
      )
    }
    if (!response.ok) {
      throw new Error(`视觉模型 ${model} 返回 HTTP ${response.status}`)
    }
    const message = payload?.choices?.[0]?.message || {}
    // Reasoning models put their answer in content and their thinking in
    // reasoning_content. Falling back to the latter keeps a useful answer
    // rather than an empty string when a model only fills the thinking field.
    const text = String(message.content || message.reasoning_content || '').trim()
    if (!text) throw new Error(`视觉模型 ${model} 未返回描述。`)
    return { text, model }
  } finally {
    clearTimeout(timer)
  }
}
