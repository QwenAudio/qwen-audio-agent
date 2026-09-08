import { currentTimeSnapshot } from '../../../conversation/frontend-agent-context.mjs'

export const GET_CURRENT_TIME_TOOL_NAME = 'get_current_time'

const getCurrentTimeTool = {
  type: 'function',
  function: {
    name: GET_CURRENT_TIME_TOOL_NAME,
    description: '获取用户本地时区中的准确当前日期、时间和星期，也可作为相对日期与时间计算的依据。',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
}

export const coreToolEntries = [
  { definition: getCurrentTimeTool },
]

export function coreToolHandlers(runtime) {
  return {
    [GET_CURRENT_TIME_TOOL_NAME]: async ({ callId, turnId }) => {
      await runtime.sendOutput(callId, {
        status: 'ok',
        ...currentTimeSnapshot(runtime.getClientContext()),
      }, turnId)
    },
  }
}
