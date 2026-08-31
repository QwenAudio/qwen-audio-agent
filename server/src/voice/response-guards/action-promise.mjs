// This guard recognizes only one short, explicit promise to execute work. It is
// deliberately not a general intent classifier: compound sentences and delivered
// answers remain the model's responsibility.

const ACTION_PROMISE = new RegExp([
  '^',
  '(?:(?:好的?|好|行|明白|收到)[，,\\s]*)?',
  '(?:稍等[，,\\s]*)?',
  '(?:',
  '我(?:来|去|先去|马上|立刻|现在(?:就)?|这就)',
  '|让我来',
  '|马上(?:去|来)?',
  '|现在就(?:去|来)?',
  ')',
  '(?:帮(?:你|您)?|替(?:你|您)?)?',
  '(?:(?:把|将)[^，,。；;：:！？!?\\n]{0,20})?',
  '(?:',
  '查(?:一下)?|查询|查找|看(?:一下)?|检查|确认|核实|搜索|排查|调查',
  '|处理|修改|调整|创建|新建|运行|跑(?:一下)?|测试|验证',
  '|加入|加到|下单|购买|播放|导航|打开|关闭',
  ')',
  '[^，,。；;：:！？!?\\n]{0,28}',
  '[。！!]?',
  '$',
].join(''))

const CONFIRMATION_REQUEST = new RegExp([
  '[？?]\\s*$',
  '好吗',
  '可以吗',
  '行吗',
  '要不要',
  '需要我',
  '是否需要',
  '要我(?:现在|先)?(?:去|来|帮)',
].join('|'))

const DELIVERED_CONTENT = /(?:[：:]|结果|答案|查到|找到|发现|显示|已经(?:完成|处理|修改|创建|运行|测试)|原因是|因为)/

export const ACTION_PROMISE_MAX_CHARS = 40

export function promisesAction(transcript) {
  const content = String(transcript || '').trim()
  if (!content || content.length > ACTION_PROMISE_MAX_CHARS) return false
  if (CONFIRMATION_REQUEST.test(content)) return false
  if (DELIVERED_CONTENT.test(content)) return false
  return ACTION_PROMISE.test(content)
}

export const actionPromiseGuard = Object.freeze({
  id: 'action-promise',
  instructions: [
    '你刚才明确承诺执行，但本轮没有调用工具。',
    '请重新判断：确需执行则立即调用合适工具；否则直接结束，不要再次承诺。',
  ].join(' '),
  matches({
    origin = 'model',
    hasFunctionCall = false,
    failed = false,
    suppressed = false,
    transcript = '',
  } = {}) {
    if (origin !== 'model') return false
    if (hasFunctionCall || failed || suppressed) return false
    return promisesAction(transcript)
  },
})
