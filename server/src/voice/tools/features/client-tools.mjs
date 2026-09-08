import { ClientActionName } from '../../../client/client-action-port.mjs'
import { toolFailure } from '../tool-result.mjs'

export const ENTER_SLEEP_TOOL_NAME = 'enter_sleep'

const enterSleepTool = {
  type: 'function',
  function: {
    name: ENTER_SLEEP_TOOL_NAME,
    description: '让当前语音入口进入其支持的休眠状态。仅在此工具可用且用户明确要求当前语音入口退下、隐藏、收起、暂时休息或离开时，必须立即调用；不要只口头回应，也不要先确认。不得用于取消后台工作、静音、退出应用，或用户未明确表达休眠意图的情况。',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
}

export const clientToolEntries = [
  {
    definition: enterSleepTool,
    policy: {
      requiredClientActions: [ClientActionName.ENTER_SLEEP],
    },
  },
]

async function enterSleep(runtime, callId, turnId) {
  if (!runtime.presenceController?.supportsSleep()) {
    await runtime.sendOutput(
      callId,
      toolFailure('client_action_unsupported', '当前入口不支持休眠。'),
      turnId,
      null,
      { createResponse: true },
    )
    return
  }
  try {
    await runtime.presenceController.requestSleep({ source: 'realtime_tool' })
    await runtime.sendOutput(
      callId,
      { status: 'sleeping' },
      turnId,
      null,
      { createResponse: false },
    )
  } catch (error) {
    await runtime.sendOutput(
      callId,
      toolFailure(
        error.code || 'client_action_failed',
        `休眠没有完成：${error.message}`,
        { retryable: true },
      ),
      turnId,
      null,
      { createResponse: true },
    )
  }
}

export function clientToolHandlers(runtime) {
  return {
    [ENTER_SLEEP_TOOL_NAME]: ({ callId, turnId }) => (
      enterSleep(runtime, callId, turnId)
    ),
  }
}
