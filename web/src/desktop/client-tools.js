// The desktop client owns both its model-visible contract and implementation.
export const desktopClientTools = Object.freeze([{
  name: 'enter_sleep',
  description: '让当前语音入口进入休眠。用户明确要求退下、隐藏、收起或暂时休息时必须立即调用，不要只口头回应。休眠不取消后台工作，不用于退出应用或单独静音。',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  response_on_success: 'none',
}])
