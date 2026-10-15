export const SPAWN_THINKING_TOOL_NAME = 'spawn_thinking'

export const spawnThinkingTool = {
  type: 'function',
  function: {
    name: SPAWN_THINKING_TOOL_NAME,
    // 客户定制点：只修改后台 Agent 的能力描述。固定调用规则位于
    // PROMPT.md，参数协议由下方 schema 定义。
    description: '新增一项后台工作，由后台 Agent 利用其工具与执行环境处理请求。新增工作不会替换或取消已有工作。',
    parameters: {
      type: 'object',
      properties: {
        objective: {
          type: 'string',
          description: '用户本次请求，必要时结合上下文补全指代；不添加用户未提出的要求。',
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
