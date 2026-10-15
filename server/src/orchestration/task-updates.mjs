import { isTaskTerminal, isUserWork } from '../task/task-state.mjs'
import { TaskDomainEvent } from '../task/task-events.mjs'

function fail(code, message) { throw Object.assign(new Error(message), { code }) }

/** Admission and durable intent only; adapters own delivery and execution strategies. */
export function updateTask(operations, { taskId, instruction, inputParts = [], submissionKey }, context) {
  const { taskManager: manager, backendRuntime: backend } = operations
  const visible = operations.get(taskId, context)
  if (!visible) fail('task_not_found', '没有找到指定工作。')
  const task = manager.tasks.get(visible.id)
  const text = String(instruction || '').trim()
  if (!text || text.length > 16_000) fail('invalid_instruction', '调整要求不能为空或超过 16000 字符。')
  if (!isUserWork(task) || task.kind !== 'work') fail('update_unsupported', '这种工作类型不支持调整。')
  if (submissionKey && task.updates?.some(entry => entry.submissionKey === submissionKey)) {
    return { status: 'duplicate', taskId: task.id }
  }
  if (!backend?.canUpdate?.()) fail('update_unsupported', '当前后台不支持调整已有工作。')
  if (task.status === 'cancelling') fail('task_cancelling', '这项工作正在取消，请等待结束。')
  if (task.inputRequest?.status === 'pending') fail('input_response_required', '请先回复或拒绝当前后台追问。')
  if (task.status === 'finalizing') fail('update_busy', '这项工作正在整理最终结果，请稍后继续。')
  if ((task.updates?.length || 0) >= 100) fail('update_limit', '这项工作的调整记录已达到上限。')
  const terminal = isTaskTerminal(task.status)
  if (terminal && task.delegation) fail('update_unsupported', '已结束的委托工作暂不支持自动恢复目标会话。')
  if (!terminal && task.delegation && task.backendPhase !== 'active') {
    fail('update_unsupported', '恢复的委托工作暂不支持调整，未提交追加要求。')
  }
  if (terminal && !task.backendContext) fail('context_unavailable', '原后台上下文不可用，不能自动重做。')
  if (terminal && task.notificationStatus === 'delivering') fail('update_busy', '上一轮结果正在投递，请稍后继续。')
  if (terminal && !task.terminalHandled && task.runner) fail('update_busy', '上一轮正在收尾，请稍后继续。')
  if (!terminal && task.backendPhase === 'settled') fail('update_busy', '当前执行正在收尾，请稍后继续。')

  let receipt
  if (!terminal && task.status !== 'queued' && task.backendPhase === 'active') {
    receipt = backend.update(task.id, { instruction: text, inputParts }, { ownerId: task.ownerId })
  }
  const entry = {
    instruction: text, inputParts, submissionKey: submissionKey || null,
    createdAt: Date.now(), status: receipt ? 'pending' : 'queued',
  }
  manager.recordUpdate(task, entry)
  // A changed requirement is not permission for newly introduced operations.
  operations.permissionPolicy?.tasks.delete(operations.permissionPolicy.taskKey(task))
  if (terminal) {
    manager.resume(task, operations.executionFor(task, {
      resumeContext: task.backendContext,
    }))
  }
  if (receipt) {
    Promise.resolve(receipt.completion).then(() => {
      entry.status = 'delivered'
      manager.emit(TaskDomainEvent.UPDATED, task)
    }, error => {
      entry.status = 'failed'
      entry.error = error.message
      manager.emit(TaskDomainEvent.UPDATED, task)
    })
  }
  return { status: 'accepted', taskId: task.id }
}

export function inputWithUpdates(task, input) {
  const queued = (task.updates || []).filter(entry => entry.status === 'queued')
  if (!queued.length) return input
  const instruction = [
    input.resumeContext ? `继续此前工作：${task.objective}` : task.objective,
    '以下是用户按时间顺序补充的要求；存在冲突时以较新的要求为准：',
    ...queued.map(entry => entry.instruction),
  ].join('\n\n')
  return { ...input, instruction, inputParts: [
    ...(input.inputParts || []), ...queued.flatMap(entry => entry.inputParts || []),
  ] }
}
