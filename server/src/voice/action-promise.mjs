// A frontend turn that promises action ("我来查一下") but ends without any tool
// call announced work it never submitted. The gateway detects that mismatch and
// asks the model to either submit the work or stay silent.
//
// Detection deliberately inspects only the assistant's own wording, never the
// user's intent. Classifying whether a request needed execution would misfire on
// ordinary conversation, whereas "I said I would, but I did not" is a
// self-contradiction that stands on its own evidence.

const ACTION_PROMISE = new RegExp([
  '我(?:来|去|先|马上|立刻|现在就)',
  '我(?:帮|给|替)(?:你|您)',
  '让我(?:来|去|看|查|试)',
  '马上(?:去|来|帮|给|开始)',
  '现在就(?:去|来|帮|给|开始)',
  '稍等',
  '等我',
].join('|'))

// A question asks for permission instead of claiming action. Correcting it would
// push the model to execute something the user has not agreed to yet.
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

// Standing down shares the first-person opening of a work promise ("我先退下了"
// against "我先查一下"), but it announces the end of the exchange instead of work
// about to start. Without this exclusion a farewell would be corrected into
// spawning a task the user never asked for.
const STANDING_DOWN = new RegExp([
  '退下',
  '不打扰',
  '不吵你',
  '休息',
  '不说了',
  '聊到这',
  '拜拜',
  '再见',
  '晚安',
  '回头(?:再)?聊',
  '(?:有事|随时)(?:再)?叫我',
  '待命',
].join('|'))

// A bare promise is short by design: the prompt asks for one concrete sentence
// before submitting work. A longer turn is already delivering substance ("我来给
// 你念一下：…"), so treating it as an unmet promise would misfire on answers the
// model legitimately handled itself.
export const ACTION_PROMISE_MAX_CHARS = 60

export const ACTION_PROMISE_CORRECTION = [
  '你刚才说了要去做，但这一轮没有提交任何执行。',
  '如果用户确实要求执行或调查，现在立即调用 spawn_thinking 提交，不要再确认一次。',
  '如果用户问的是既有工作的状态或进度，改用 get_agent_task_status。',
  '如果确实不需要执行，就不要再说话。',
].join(' ')

export function promisesAction(transcript) {
  const content = String(transcript || '').trim()
  if (!content || content.length > ACTION_PROMISE_MAX_CHARS) return false
  if (STANDING_DOWN.test(content)) return false
  if (CONFIRMATION_REQUEST.test(content)) return false
  return ACTION_PROMISE.test(content)
}

export function shouldCorrectActionPromise({
  origin = 'model',
  hasFunctionCall = false,
  failed = false,
  suppressed = false,
  transcript = '',
  alreadyCorrected = false,
} = {}) {
  // Announcements and permission prompts are delivery, not routing decisions.
  if (origin !== 'model') return false
  // A tool call means the promise was kept.
  if (hasFunctionCall) return false
  // An interrupted, cancelled or failed turn proves nothing about routing.
  if (failed || suppressed) return false
  // One correction per turn. The correction itself produces a model response,
  // so re-entering this check without the guard would loop indefinitely.
  if (alreadyCorrected) return false
  return promisesAction(transcript)
}
