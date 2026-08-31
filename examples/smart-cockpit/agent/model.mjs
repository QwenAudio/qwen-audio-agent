import OpenAI from 'openai'

export const DEFAULT_COCKPIT_AGENT_MODEL = 'qwen3.8-flash'

export class DashScopeCockpitModel {
  constructor({
    apiKey = process.env.DASHSCOPE_API_KEY,
    baseURL = process.env.DASHSCOPE_BASE_URL
      || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model = process.env.DASHSCOPE_MODEL || DEFAULT_COCKPIT_AGENT_MODEL,
    client,
  } = {}) {
    if (!client && !apiKey) {
      throw new Error('Cockpit Agent requires DASHSCOPE_API_KEY')
    }
    this.client = client || new OpenAI({ apiKey, baseURL })
    this.model = model
  }

  async complete({ messages, tools, signal }) {
    const completion = await this.client.chat.completions.create({
      model: this.model,
      messages,
      tools,
      tool_choice: tools.length ? 'auto' : undefined,
      enable_thinking: true,
    }, signal ? { signal } : undefined)
    const message = completion.choices?.[0]?.message
    if (!message) throw new Error('Cockpit Agent model returned no message')
    return message
  }
}
