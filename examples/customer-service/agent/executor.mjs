import { randomUUID } from 'node:crypto'
import { Role, TaskState } from '@a2a-js/sdk'
import { AgentEvent } from '@a2a-js/sdk/server'
import { DashScopeServiceModel } from './model.mjs'

const MAX_AGENT_ROUNDS = 8

// 【为什么这份 prompt 是域无关的】
// 第一版写死成零售：「你是零售客服的后台 Agent」「查订单、查款式库存由前台处理」
// 「工具返回『超出退货时限』『订单不是未发货状态』时……」。
// 航空组起来之后这份 prompt 全说错了域 —— 而它的工具面是从 /mcp/backend
// 动态拉的（service 按域挑），所以工具对、话术错，那种错最难察觉。
//
// 改法不是写两份，是把域特定的东西全拿掉：
//
//   一、不列举具体的判定结果。第一版列了零售的四种，而航空有「已有航段执飞」
//      「特价经济舱不可改签」「保险退款原因只认健康或天气」「金额超上限」……
//      列不全。改成「工具返回的判定照实转达」——
//      判定话术是工具自己写的，prompt 里再抄一遍只会不一致。
//
//   二、不列举工具名。写「取消订单、退货、改地址是两段式」会漏掉航空那五个，
//      而漏掉的那些模型可能就不走批准链了。改成按【返回里有没有 approval_token】
//      判断，那是所有两段式工具的共同特征。
//
// 剩下的域特定信息只有一个业务名字，从 CS_DOMAIN 取。
const DOMAIN_LABEL = Object.freeze({
  retail: '零售客服',
  airline: '航空客服',
})

export function serviceAgentPrompt(domain = process.env.CS_DOMAIN || 'retail') {
  return `你是${DOMAIN_LABEL[domain] || '客服'}的后台 Agent，负责执行前台交给你的业务操作。

规则：
- 身份核验和只读查询由前台低延迟处理。你收到的是需要改动数据的任务。
- 必须用提供的工具真实执行，不得假装已完成，也不得凭常识判断时限、资格或金额。
- 改动数据的工具是两段式：第一次调用会返回一段预览和一个 approval_token，
  此时数据没有变化。你要把预览原样交给前台去向客户确认，拿到客户同意后
  再带 approval_token 调用第二次。看返回里有没有 approval_token 就知道
  这一步是不是预览。
- 工具返回的业务判定（不符合条件、细则未覆盖、超出权限等）照实转达，
  不要换个说法再试一次，也不要自己估算天数、差价或补偿金额。
- 需要转人工时调用 transfer_to_human，并写清原因。
- 最终回复要简短、自然，适合前台语音助手直接念给客户听。金额和单号要写完整。`
}

// 兼容旧引用（测试里按这个名字取）。默认域的那一份。
export const SERVICE_AGENT_PROMPT = serviceAgentPrompt()

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
    throw new Error(`Invalid arguments for customer service tool ${call?.function?.name || ''}`)
  }
}

// 【auth_required 的触发点】工具返回 needsApproval 时，把预览抛出去，
// 由 execute() 转成 TASK_STATE_AUTH_REQUIRED 并挂起任务。
//
// 为什么不让模型自己决定要不要问：模型可能直接编一个 token 再调一次
// （已在 service 层实测过这条路会被令牌校验挡住），也可能干脆跳过确认
// 直接向客户宣布「已经取消了」。改成由工具返回值驱动，模型没有选择权。
class ApprovalNeeded extends Error {
  constructor(preview) {
    super('approval required')
    this.name = 'ApprovalNeeded'
    this.preview = preview
  }
}

async function runServiceAgent({ objective, model, tools, signal, onToolCall }) {
  const definitions = (await tools.list({ signal })).map(openAiTool)
  const allowed = new Set(definitions.map(tool => tool.function.name))
  const messages = [
    // 【运行时取，不用模块加载时的快照】SERVICE_AGENT_PROMPT 是导入那一刻
    // 就定下的，而测试会在导入之后改 CS_DOMAIN 来验分域。
    { role: 'system', content: serviceAgentPrompt() },
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
        content: String(message.content || lastContent || '已处理').trim(),
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
      if (!allowed.has(name)) {
        throw new Error(`Customer service Agent selected unknown tool: ${name}`)
      }
      const args = toolArguments(call)
      onToolCall?.({ name, args })
      const result = await tools.call(name, args, { signal })
      lastContent = result.content
      lastData = result.data || lastData
      if (result.data?.needsApproval) throw new ApprovalNeeded(result.content)
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: result.content,
      })
    }
  }
  throw new Error(`Customer service Agent exceeded ${MAX_AGENT_ROUNDS} model rounds`)
}

export class ServiceAgentExecutor {
  constructor({ tools, model = new DashScopeServiceModel() }) {
    if (!tools?.list || !tools?.call) {
      throw new TypeError('Customer service Agent requires an MCP tool client')
    }
    if (!model?.complete) throw new TypeError('Customer service Agent requires a chat model')
    this.tools = tools
    this.model = model
    this.controllers = new Map()
    // 挂起中的任务：客户批准之后要从这里接着往下走，而不是重新开始。
    // 上下文（objective + 已走过的工具调用）留在后台，这是 auth_required
    // 相对「让前台重新派活」的全部价值所在。
    this.suspended = new Map()
  }

  async execute(requestContext, eventBus) {
    const { taskId, contextId } = requestContext
    const controller = new AbortController()
    this.controllers.set(taskId, controller)
    const objective = inputText(requestContext.userMessage)

    // 挂起的任务被再次调用 = 客户已经回答。把回答拼进 objective 继续。
    const pending = this.suspended.get(contextId)
    const resumed = Boolean(pending)
    if (resumed) this.suspended.delete(contextId)

    try {
      // 【首个事件必须是 Task，但只在任务真正新建时发】
      // 不发：客户端报 Received statusUpdate before initial 'Message'/'Task' event.
      // 重发：客户端报 Stream ordering violation: received task in task lifecycle stream.
      // 恢复执行时 requestContext.task 已经在流里了，这时只能发 statusUpdate。
      if (!requestContext.task) {
        eventBus.publish(AgentEvent.task({
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
        }))
      }

      eventBus.publish(statusUpdate(taskId, contextId, TaskState.TASK_STATE_WORKING,
        resumed ? '收到客户答复，继续处理。' : '正在处理。'))

      // 【恢复时必须把预览原文交回给模型】预览里含 approval_token，
      // 而 runServiceAgent 每次都是空对话开局 —— 不把它带回来，模型只能
      // 重新取一次预览，于是又挂起一次，客户会被问第二遍。
      // 这不是测试问题：真实模型同样看不到上一轮的工具返回。
      const finalObjective = resumed
        ? `${pending.objective}

你上一步已经取得下面这份待确认内容（其中包含 approval_token）：
${pending.preview}

客户对此的答复是：${objective}

如果客户同意，就带上上面那个 approval_token 再调用一次同一个工具，把操作完成。
如果客户不同意或没有明确同意，不要调用任何工具，直接说明这笔操作没有执行。`
        : objective

      const output = await runServiceAgent({
        objective: finalObjective,
        model: this.model,
        tools: this.tools,
        signal: controller.signal,
        onToolCall: ({ name }) => {
          eventBus.publish(statusUpdate(taskId, contextId,
            TaskState.TASK_STATE_WORKING, `正在执行 ${name}`))
        },
      })

      eventBus.publish(statusUpdate(taskId, contextId,
        TaskState.TASK_STATE_COMPLETED, output.content))
    } catch (error) {
      if (error instanceof ApprovalNeeded) {
        // 预览要一起存：它是恢复时唯一能把 approval_token 交回模型的载体。
        this.suspended.set(contextId, {
          objective,
          preview: error.preview,
          at: Date.now(),
        })
        // 【关键一步】TASK_STATE_AUTH_REQUIRED + 一条带预览的消息。
        // Gateway 侧的 a2a-backend-adapter 会把它转成 auth_required 状态，
        // prompt 取自这条消息的文本，再由前台语音念给客户。
        eventBus.publish(statusUpdate(taskId, contextId,
          TaskState.TASK_STATE_AUTH_REQUIRED, error.preview))
        return
      }
      if (controller.signal.aborted) {
        eventBus.publish(statusUpdate(taskId, contextId,
          TaskState.TASK_STATE_CANCELED, '任务已取消。'))
        return
      }
      eventBus.publish(statusUpdate(taskId, contextId,
        TaskState.TASK_STATE_FAILED, error.message || '处理失败。'))
    } finally {
      this.controllers.delete(taskId)
    }
  }

  async cancelTask(taskId) {
    this.controllers.get(taskId)?.abort()
  }
}
