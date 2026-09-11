export const SPAWN_THINKING_TOOL_NAME = 'spawn_thinking'

export const spawnThinkingTool = {
  type: 'function',
  function: {
    name: SPAWN_THINKING_TOOL_NAME,
    // 客户定制点：只修改后台 Agent 的能力描述。固定调用规则位于
    // PROMPT.md，参数协议由下方 schema 定义。
    description: '调用后台 Agent 访问或操作用户环境、设备、文件、屏幕、应用和代码，进行媒体创作、持续执行和制作交付物；也用于在用户补充信息、作出选择或确认后继续、修改已有工作。',
    parameters: {
      type: 'object',
      properties: {
        objective: {
          type: 'string',
          description: '忠实、完整且自包含地转达用户要做什么及其明确约束，保留执行方式及与既有工作的关系。根据当前对话消解明确指代，只补充完成它所必需的事实或约束；不得遗漏、推断或改变用户语义，不要规定用户未要求的具体工具、Agent 或 Session，也不要提交占位目标。后台不会收到前台的完整对话、个性化偏好或长期记忆。',
        },
        input_refs: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 8,
          description: '仅当任务依赖此前轮次标注为“可引用输入”的图片或文件时填写对应 input_N；本轮提交的输入会自动携带。没有相关输入时省略，不得猜造引用。',
        },
      },
      required: ['objective'],
      additionalProperties: false,
    },
  },
}

export function withSpawnThinkingDescription(description) {
  const customized = String(description || '').trim()
  if (!customized || customized === spawnThinkingTool.function.description) {
    return spawnThinkingTool
  }
  return {
    ...spawnThinkingTool,
    function: {
      ...spawnThinkingTool.function,
      description: customized,
    },
  }
}
