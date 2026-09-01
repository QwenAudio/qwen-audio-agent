import { randomUUID } from 'node:crypto'
import {
  Role,
  TaskState,
} from '@a2a-js/sdk'
import { AgentEvent } from '@a2a-js/sdk/server'
import { DashScopeCockpitModel } from './model.mjs'

const MAX_AGENT_ROUNDS = 8

export const COCKPIT_AGENT_PROMPT = `你是智能座舱的后台 Agent，负责理解并执行座舱任务。

规则：
- 天窗、空调、导航、音乐和闪购操作必须使用提供的工具，不得假装已经执行。车况查询、车窗和大灯由前台处理，不属于本后台 Agent 的工具面。
- 复杂请求可以连续调用多个工具；严格按照用户表达的先后顺序执行。
- 导航请求可以包含多个有序途经点。将中间地点放入 waypoints，最后一个地点作为 destination。
- 用户明确说“导航到”“带我去”“去某地”或“开始导航”时直接调用 navigation_start，成功后不要再次询问是否开始。
- 只有用户明确说“查路线”“怎么走”“多远”“多久”或“先看看路线”时才调用 navigation_route_query。
- 用户在已有导航中说“中途去一下”“顺路去”“加个途经点”时调用 navigation_add_waypoint；说“不去这个途经点了”“取消途经点”时调用 navigation_remove_waypoint。
- 用户在已有导航中说“目的地改成”“换个地方”时调用 navigation_change_destination；只说“换成不走高速”“改成少收费”“避开拥堵”时调用 navigation_set_route_strategy。
- 用户只是找地点或周边 POI、没有要求导航时，调用 navigation_search_place。
- “回家”“去公司”等常用地点导航优先调用 navigation_to_favorite；设置家/公司/学校地址时调用 navigation_set_favorite。
- 导航静音、详细播报、简洁播报调用 navigation_set_voice；查看全程、跟车视角、北向上调用 navigation_set_view。
- 闪购中，只有“看看”“搜一下”“有哪些”等浏览意图使用 search；“帮我点”“来一份”“就这个”“加入购物车”使用 add_to_cart，不得退回再次搜索。
- 闪购加购后必须先返回订单预览；只有用户在后续指令中明确确认后，才调用 confirm_order。
- 地点、对象或高风险操作存在关键歧义时，先用一句简短中文追问，不要笼统声称系统不支持。
- 不处理普通闲聊、桌面文件、代码或未提供工具的业务；只简洁说明座舱 Agent 的能力边界。
- 最终回复应简短、自然，适合由前台语音助手直接播报。`

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

function openAiTool(tool) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || tool.title || tool.name,
      parameters: tool.inputSchema || { type: 'object', properties: {} },
    },
  }
}

function toolArguments(call) {
  try {
    return JSON.parse(call?.function?.arguments || '{}')
  } catch {
    throw new Error(`Invalid arguments for cockpit tool ${call?.function?.name || ''}`)
  }
}

async function runCockpitAgent({ objective, model, tools, signal, onToolCall }) {
  const definitions = (await tools.list({ signal })).map(openAiTool)
  const allowed = new Set(definitions.map(tool => tool.function.name))
  const messages = [
    { role: 'system', content: COCKPIT_AGENT_PROMPT },
    { role: 'user', content: objective },
  ]
  let lastContent = ''
  let lastData = {}

  for (let round = 0; round < MAX_AGENT_ROUNDS; round += 1) {
    if (signal.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError')
    const message = await model.complete({ messages, tools: definitions, signal })
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : []
    if (!calls.length) {
      return {
        content: String(message.content || lastContent || '座舱任务已处理').trim(),
        data: lastData,
      }
    }
    messages.push({
      role: 'assistant',
      content: message.content || null,
      tool_calls: calls,
    })
    for (const call of calls) {
      const name = String(call?.function?.name || '')
      if (!allowed.has(name)) throw new Error(`Cockpit Agent selected unknown tool: ${name}`)
      const args = toolArguments(call)
      onToolCall?.({ name, args })
      const result = await tools.call(name, args, { signal })
      lastContent = result.content
      lastData = result.data || lastData
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: result.content,
      })
    }
  }
  throw new Error(`Cockpit Agent exceeded ${MAX_AGENT_ROUNDS} model rounds`)
}

export class CockpitAgentExecutor {
  constructor({ tools, model = new DashScopeCockpitModel() }) {
    if (!tools?.list || !tools?.call) {
      throw new TypeError('Cockpit Agent requires an MCP tool client')
    }
    if (!model?.complete) throw new TypeError('Cockpit Agent requires a chat model')
    this.tools = tools
    this.model = model
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
    eventBus.publish(statusUpdate(
      taskId,
      contextId,
      TaskState.TASK_STATE_WORKING,
      '座舱 Agent 正在理解并执行任务',
    ))

    const controller = new AbortController()
    this.controllers.set(taskId, controller)
    try {
      const result = await runCockpitAgent({
        objective: inputText(requestContext.userMessage),
        model: this.model,
        tools: this.tools,
        signal: controller.signal,
        onToolCall: ({ name }) => eventBus.publish(statusUpdate(
          taskId,
          contextId,
          TaskState.TASK_STATE_WORKING,
          `正在执行座舱能力：${name}`,
        )),
      })
      eventBus.publish(AgentEvent.artifactUpdate({
        taskId,
        contextId,
        artifact: {
          artifactId: randomUUID(),
          name: 'Cockpit result',
          description: 'Result from the model-powered cockpit Agent.',
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
