import { normalizeRecurrence } from '../../../task/recurrence.mjs'
import { toolFailure } from '../tool-result.mjs'

export const SCHEDULE_REMINDER_TOOL_NAME = 'schedule_reminder'

const scheduleReminderTool = {
  type: 'function',
  function: {
    name: SCHEDULE_REMINDER_TOOL_NAME,
    description: '创建未来触发的提醒或后台任务，不用于仅记录清单条目。先调用 get_current_time 确定当前时间，再计算触发时间。',
    parameters: {
      type: 'object',
      properties: {
        execute_at: {
          type: 'string',
          description: '基于用户本地时区计算的触发时间，使用包含时区偏移的 ISO 8601 时间戳。',
        },
        reminder: {
          type: 'string',
          description: '提醒内容或任务描述。忠实保留用户要提醒或执行的事项。',
        },
        type: {
          type: 'string',
          enum: ['reminder', 'task'],
          description: 'reminder=到点播报内容（默认）；task=到点由后台 Agent 执行后播报结果，需要已配置后台。用户只要求提醒用 reminder；要求执行某事再告知用 task。',
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
  { definition: scheduleReminderTool },
]

const reminderOnlyTool = {
  ...scheduleReminderTool,
  function: {
    ...scheduleReminderTool.function,
    description: '创建未来触发的提醒，不执行后台任务。先调用 get_current_time 确定当前时间，再计算触发时间。',
    parameters: {
      ...scheduleReminderTool.function.parameters,
      properties: {
        ...scheduleReminderTool.function.parameters.properties,
        type: {
          type: 'string',
          enum: ['reminder'],
          description: '到点播报提醒内容（默认），不执行后台任务。',
        },
      },
    },
  },
}

export function scheduleToolForContext(context) {
  return context?.frontend?.backendConfigured === false
    ? reminderOnlyTool
    : scheduleReminderTool
}

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
  if (type === 'task' && runtime.backendAvailability?.snapshot()?.configured === false) {
    await runtime.sendOutput(callId, toolFailure(
      'backend_unavailable',
      '当前未配置后台 Agent，无法创建定时执行任务；仍可创建到点播报的提醒。',
    ), turnId)
    return
  }
  const recurrence = normalizeRecurrence(args.recurrence)
  const backendRuntime = runtime.backendRuntime
  const runner = type === 'task'
    ? async (objective, context) => backendRuntime.run({ objective }, {
        ownerId: context.ownerId,
        sessionId: context.sessionId,
        turnId: context.turnId,
        taskId: context.taskId,
        signal: context.signal,
        onEvent: event => runtime.forwardBackendEvent(context.taskId, event, context.onEvent),
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
