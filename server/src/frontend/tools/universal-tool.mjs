import { spawnThinkingTool } from './spawn-thinking-tool.mjs'

export const UNIVERSAL_TOOL_NAME = 'universal_tool'

// A new model-facing entry point, sharing the existing backend task protocol.
export const universalTool = {
  ...spawnThinkingTool,
  function: {
    ...spawnThinkingTool.function,
    name: UNIVERSAL_TOOL_NAME,
    description: '万能工具，可以用于一切情况，由后台 Agent 利用其工具与执行环境处理请求。效率较低，在其它工具适用时优先使用其它工具。新增工作不会替换或取消已有工作。',
  },
}
