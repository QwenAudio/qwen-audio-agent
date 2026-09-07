import { normalizeRecurrence } from '../../../task/recurrence.mjs'

export const SCHEDULE_REMINDER_TOOL_NAME = 'schedule_reminder'

const scheduleReminderTool = {
  type: 'function',
  function: {
    name: SCHEDULE_REMINDER_TOOL_NAME,
    description: '创建定时提醒或定时任务。用户说"X点提醒我""明天三点帮我查某事然后告诉我"等时间驱动的提醒或任务时调用。先调用 get_current_time 获取当前时间，计算目标时间后传入 execute_at。type=reminder 时到点直接播报 reminder 内容；type=task 时到点执行 reminder 描述的任务，执行完播报结果。',
    parameters: {
      type: 'object',
      properties: {
        execute_at: {
          type: 'string',
          description: 'ISO 8601 时间戳，触发时间。基于 get_current_time 返回的时区计算。',
        },
        reminder: {
          type: 'string',
          description: '提醒内容或任务描述。忠实保留用户要提醒或执行的事项。',
        },
        type: {
          type: 'string',
          enum: ['reminder', 'task'],
          description: 'reminder=到点播报内容；task=到点执行任务后播报结果。用户只要求提醒用 reminder；要求执行某事再告知用 task。',
        },
        recurrence: {
          type: 'string',
          enum: ['once', 'daily', 'weekly', 'weekdays'],
          description: '重复模式，默认 once；daily=每天，weekly=每周，weekdays=每周一至周五。重复提醒按客户端时区保留本地时间。',
        },
      },
      required: ['execute_at', 'reminder'],
      additionalProperties: false,
    },
  },
}

export const scheduleToolEntries = [
  { definition: scheduleReminderTool, policy: { mode: 'inline' } },
]

async function scheduleReminder(runtime, callId, turnId, args) {
  const executeAt = Date.parse(args.execute_at)
  if (!executeAt || executeAt <= Date.now()) {
    await runtime.sendOutput(callId, {
      status: 'error',
      error: true,
      error_code: 'invalid_time',
      user_message: '触发时间无效或已过期，请提供一个未来的时间。',
    }, turnId)
    return
  }

  const type = args.type === 'task' ? 'task' : 'reminder'
  const recurrence = normalizeRecurrence(args.recurrence)
  const backendRuntime = runtime.backendRuntime
  const runner = type === 'task'
    ? async (objective, context) => backendRuntime.run({ objective }, {
        ownerId: context.ownerId,
        sessionId: context.sessionId,
        turnId: context.turnId,
        taskId: context.taskId,
        signal: context.signal,
        onEvent: context.onEvent,
      })
    : null

  const task = runtime.taskManager.createScheduled({
    objective: args.reminder,
    ownerId: runtime.ownerId,
    sessionId: runtime.sessionId,
    turnId,
    schedule: {
      at: executeAt,
      recurrence,
      ...(recurrence === 'once'
        ? {}
        : { timeZone: runtime.getClientContext()?.timeZone }),
    },
    type,
    runner,
  })

  await runtime.sendOutput(callId, {
    status: 'scheduled',
    task_id: task.id,
    execute_at: args.execute_at,
    type,
    recurrence,
    ...(task.seriesId ? { series_id: task.seriesId } : {}),
  }, turnId, task.id, {
    response: {
      instructions: [
        '用一句自然的话确认已设好提醒，包含具体时间和内容。',
        '不要调用工具，不要重复确认。',
      ].join(' '),
    },
  })
}

export function scheduleToolHandlers(runtime) {
  return {
    [SCHEDULE_REMINDER_TOOL_NAME]: ({ callId, turnId, args }) => (
      scheduleReminder(runtime, callId, turnId, args)
    ),
  }
}
