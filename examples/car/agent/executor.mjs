import { randomUUID } from 'node:crypto'
import {
  Role,
  TaskState,
} from '@a2a-js/sdk'
import { AgentEvent } from '@a2a-js/sdk/server'
import {
  describePlan,
  planCockpitTool,
} from './intent-router.mjs'

function textPart(text) {
  return {
    content: { $case: 'text', value: String(text || '') },
    metadata: undefined,
    filename: '',
    mediaType: 'text/plain',
  }
}

function agentMessage(text, { taskId, contextId } = {}) {
  return {
    messageId: randomUUID(),
    contextId: contextId || '',
    taskId: taskId || '',
    role: Role.ROLE_AGENT,
    parts: [textPart(text)],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  }
}

function inputText(message) {
  return (message?.parts || [])
    .filter(part => part?.content?.$case === 'text')
    .map(part => part.content.value)
    .join('\n')
    .trim()
}

function statusUpdate(taskId, contextId, state, message) {
  return AgentEvent.statusUpdate({
    taskId,
    contextId,
    status: {
      state,
      timestamp: new Date().toISOString(),
      message: message ? agentMessage(message, { taskId, contextId }) : undefined,
    },
    metadata: undefined,
  })
}

export class CockpitAgentExecutor {
  constructor({ tools }) {
    if (!tools?.call) throw new TypeError('Cockpit Agent requires an MCP tool client')
    this.tools = tools
    this.controllers = new Map()
  }

  async execute(requestContext, eventBus) {
    const { taskId, contextId } = requestContext
    const task = requestContext.task || {
      id: taskId,
      contextId,
      status: {
        state: TaskState.TASK_STATE_SUBMITTED,
        timestamp: new Date().toISOString(),
        message: undefined,
      },
      artifacts: [],
      history: [requestContext.userMessage],
      metadata: requestContext.userMessage.metadata,
    }
    eventBus.publish(AgentEvent.task(task))
    const plan = planCockpitTool(inputText(requestContext.userMessage))
    eventBus.publish(statusUpdate(
      taskId,
      contextId,
      TaskState.TASK_STATE_WORKING,
      describePlan(plan),
    ))

    const controller = new AbortController()
    this.controllers.set(taskId, controller)
    try {
      const result = plan
        ? await this.tools.call(plan.name, plan.arguments, { signal: controller.signal })
        : {
            content: '这个轻量示例的后台 Agent 只演示车控、导航、音乐和闪购能力。',
            data: {},
          }
      eventBus.publish(AgentEvent.artifactUpdate({
        taskId,
        contextId,
        artifact: {
          artifactId: randomUUID(),
          name: 'Cockpit result',
          description: 'Result from the lightweight cockpit example Agent.',
          parts: [textPart(result.content)],
          metadata: result.data,
          extensions: [],
        },
        append: false,
        lastChunk: true,
        metadata: undefined,
      }))
      eventBus.publish(statusUpdate(
        taskId,
        contextId,
        TaskState.TASK_STATE_COMPLETED,
        result.content,
      ))
    } catch (error) {
      const cancelled = controller.signal.aborted || error?.name === 'AbortError'
      eventBus.publish(statusUpdate(
        taskId,
        contextId,
        cancelled
          ? TaskState.TASK_STATE_CANCELED
          : TaskState.TASK_STATE_FAILED,
        cancelled ? '座舱任务已取消' : `座舱任务失败：${error?.message || error}`,
      ))
    } finally {
      this.controllers.delete(taskId)
    }
  }

  async cancelTask(taskId) {
    this.controllers.get(taskId)?.abort()
  }
}
