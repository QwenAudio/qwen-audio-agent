import { randomUUID } from 'node:crypto'
import { Role, TaskState } from '@a2a-js/sdk'
import { AgentEvent } from '@a2a-js/sdk/server'
import { DashScopeServiceModel } from './model.mjs'
import { flowPrompt } from './flows.mjs'
import { AgentHistory } from '../../shared/agent-history.mjs'

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
- 可以根据此前任务及回复理解后续要求；历史结果不是当前业务状态，也不代表本次操作已获客户批准。
- 身份核验和只读查询由前台低延迟处理。你收到的是需要改动数据的任务。
- 必须用提供的工具真实执行，不得假装已完成，也不得凭常识判断时限、资格或金额。
- 改动数据的工具是两段式：第一次调用会返回一段预览和一个 approval_token，
  此时数据没有变化。你要把预览原样交给前台去向客户确认，拿到客户同意后
  再带 approval_token 调用第二次。看返回里有没有 approval_token 就知道
  这一步是不是预览。
- 工具返回的业务判定（不符合条件、细则未覆盖、超出权限等）照实转达，
  不要换个说法再试一次，也不要自己估算天数、差价或补偿金额。
- 需要转人工时调用 transfer_to_human，并写清原因。
- 最终回复要简短、自然，适合前台语音助手直接念给客户听。金额和单号要写完整。

【客户只知道一个客服，就是你】你的回复会被【原话念给客户】，所以里面不能出现
这套系统的内部结构。不要说"后台"、"前台"、"后台客服"、"提交后台处理"、
"Agent"、"系统"、"工单"、"接口"、"我这边转给"这类话 —— 客户听到"提交后台客服"
会以为要换个人接手，而实际上从头到尾就是你在办。
- 要客户确认时，直接说清【要办的是什么事、金额多少】，然后问他同不同意。
  不要解释为什么需要确认，也不要描述这件事在内部怎么流转。
  ✗ "这个操作涉及金额，我需要提交后台客服处理，您确定吗？"
  ✓ "这笔会退还 120 元到您的原支付账户，确认为您办理吗？"
- 只有真的要把客户交给人类坐席时（调 transfer_to_human），才可以提"人工客服"。
  那时说"我帮您转接人工客服"，别的情况都不要提转接。${flowPrompt(domain)}`
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

async function runServiceAgent({ objective, history, model, tools, signal, onToolCall }) {
  const definitions = (await tools.list({ signal })).map(openAiTool)
  const allowed = new Set(definitions.map(tool => tool.function.name))
  const messages = [
    // 【运行时取，不用模块加载时的快照】SERVICE_AGENT_PROMPT 是导入那一刻
    // 就定下的，而测试会在导入之后改 CS_DOMAIN 来验分域。
    { role: 'system', content: serviceAgentPrompt() },
    ...history,
    { role: 'user', content: objective },
  ]
  let lastContent = ''
  let lastData = {}

  for (let round = 0; round < MAX_AGENT_ROUNDS; round += 1) {
    if (signal.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError')
    const message = await model.complete({ messages, tools: definitions, signal })
    signal.throwIfAborted()
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
      signal.throwIfAborted()
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
    this.history = new AgentHistory()
    this.conversationId = null
    // Approval belongs to a Task, not its shared conversation context.
    this.suspended = new Map()
  }

  async execute(requestContext, eventBus) {
    const { taskId, contextId } = requestContext
    const controller = new AbortController()
    this.controllers.set(taskId, controller)
    const objective = inputText(requestContext.userMessage)

    let history = null
    let historyObjective = objective
    try {
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
      if (this.tools.conversationId) {
        const id = await this.tools.conversationId({ signal: controller.signal })
        controller.signal.throwIfAborted()
        if (this.conversationId !== null && this.conversationId !== id) {
          this.history = new AgentHistory()
          this.suspended.clear()
          for (const [otherTaskId, other] of this.controllers) {
            if (otherTaskId !== taskId) other.abort()
          }
        }
        this.conversationId = id
      }
      history = this.history
      const pending = this.suspended.get(taskId)
      if (pending && pending.contextId !== contextId) {
        throw new Error('Pending approval belongs to another conversation')
      }
      const resumed = Boolean(pending)
      if (resumed) {
        this.suspended.delete(taskId)
        historyObjective = `${pending.objective}\n\n客户补充：${objective}`
      }
      eventBus.publish(statusUpdate(taskId, contextId, TaskState.TASK_STATE_WORKING,
        resumed ? '收到客户答复，继续处理。' : '正在处理。'))

      // Only the resumed Task receives its approval preview. Completed history
      // contains requests and final replies, never this internal continuation.
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
        history: history.messages(contextId),
        model: this.model,
        tools: this.tools,
        signal: controller.signal,
        onToolCall: ({ name }) => {
          eventBus.publish(statusUpdate(taskId, contextId,
            TaskState.TASK_STATE_WORKING, `正在执行 ${name}`))
        },
      })
      history.append(contextId, historyObjective, output.content)
      eventBus.publish(statusUpdate(taskId, contextId,
        TaskState.TASK_STATE_COMPLETED, output.content))
    } catch (error) {
      if (error instanceof ApprovalNeeded && !controller.signal.aborted && history === this.history) {
        // 预览要一起存：它是恢复时唯一能把 approval_token 交回模型的载体。
        this.suspended.set(taskId, {
          contextId,
          objective: historyObjective,
          preview: error.preview,
          history,
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
        history?.append(contextId, historyObjective, '任务已取消；已执行操作的当前状态需通过工具核实。')
        eventBus.publish(statusUpdate(taskId, contextId,
          TaskState.TASK_STATE_CANCELED, '任务已取消。'))
        return
      }
      history?.append(contextId, historyObjective, `任务未完成：${error.message || '处理失败'}。已执行操作的当前状态需通过工具核实。`)
      eventBus.publish(statusUpdate(taskId, contextId,
        TaskState.TASK_STATE_FAILED, error.message || '处理失败。'))
    } finally {
      this.controllers.delete(taskId)
    }
  }

  async cancelTask(taskId) {
    this.controllers.get(taskId)?.abort()
    const pending = this.suspended.get(taskId)
    if (pending) {
      this.suspended.delete(taskId)
      pending.history.append(pending.contextId, pending.objective, '客户取消了待确认任务，未继续执行该操作。')
    }
  }
}
