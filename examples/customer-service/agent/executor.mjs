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
- 可以根据此前已完成任务及回复理解后续要求；历史结果不是当前业务状态，也不代表本次写操作已获批准。
- 身份核验和只读查询由前台低延迟处理。你收到的是需要改动数据的任务。
- 必须用提供的工具真实执行，不得假装已完成，也不得凭常识判断时限、资格或金额。
- 改动数据的工具是两段式：第一次调用会取得预览，此时数据没有变化。
  运行时会挂起任务，向客户展示预览；明确批准后由运行时提交保存的操作。
  不要自己填写 approval_token，也不要尝试跳过确认。
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

function agentMessage(text, { taskId, contextId, metadata } = {}) {
  return {
    messageId: randomUUID(),
    contextId: contextId || '',
    taskId: taskId || '',
    role: Role.ROLE_AGENT,
    parts: [textPart(text)],
    metadata,
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

function statusUpdate(taskId, contextId, state, message, metadata) {
  return AgentEvent.statusUpdate({
    taskId,
    contextId,
    status: {
      state,
      timestamp: new Date().toISOString(),
      message: message ? agentMessage(message, { taskId, contextId, metadata }) : undefined,
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
  constructor(preview, operation, messages) {
    super('approval required')
    this.name = 'ApprovalNeeded'
    this.preview = preview
    this.operation = operation
    this.messages = messages
  }
}

class CustomerInputNeeded extends Error {
  constructor(prompt, messages, callId, remainingCalls) {
    super('customer input required')
    this.prompt = prompt
    this.messages = messages
    this.callId = callId
    this.remainingCalls = remainingCalls
  }
}

const customerInputTool = {
  type: 'function', function: {
    name: 'ask_customer',
    description: 'Request missing information, a choice, or policy confirmation from the customer and suspend this same task. Use this tool instead of ending with a question. This is NOT database authorization; write tools still require runtime approval.',
    parameters: { type: 'object', properties: { question: { type: 'string', minLength: 1 } },
      required: ['question'], additionalProperties: false },
  },
}

async function runServiceAgent({ objective, model, tools, signal, onToolCall,
  history = [], initialMessages, initialCalls = [], initialOutput, committedOperations = 0 }) {
  const definitions = (await tools.list({ signal })).map(openAiTool)
  definitions.push(customerInputTool)
  const allowed = new Set(definitions.map(tool => tool.function.name))
  const context = await tools.context?.({ signal })
  const prompt = context?.toolset?.startsWith('tau-')
    ? `${context.policy}\n\nRuntime: tools execute the official tau environment. Writes require explicit customer approval.\nDo not supply approval_token; the runtime previews and commits saved operations after authorization.\nIdentity checks and read tools may be used here when needed. Follow the policy and never claim an action was completed without a tool result.`
    : serviceAgentPrompt()
  const identity = context?.verifiedIdentity
  const sharedContext = identity ? `\n\nTrusted session context: the customer has ALREADY been authenticated in this SAME conversation by the official tool ${identity.method}, with arguments ${JSON.stringify(identity.arguments)}, returning user_id ${JSON.stringify(identity.userId)}. This is a continuation, not a new conversation. Do not require authentication again or act on another customer's account. This identity is NOT authorization to update data.` : ''
  const messages = initialMessages || [
    // 【运行时取，不用模块加载时的快照】SERVICE_AGENT_PROMPT 是导入那一刻
    // 就定下的，而测试会在导入之后改 CS_DOMAIN 来验分域。
    { role: 'system', content: `${prompt}${sharedContext}\nWhen customer information, selection, or confirmation is missing, call ask_customer. Do not end a task with a question. A task ending is not evidence of a database update. Never claim a write succeeded without its committed tool result.` },
    ...history,
    { role: 'user', content: objective },
  ]
  let lastContent = initialOutput?.content || ''
  let lastData = initialOutput?.data || {}

  for (let round = 0; round < MAX_AGENT_ROUNDS; round += 1) {
    if (signal.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError')
    const queued = round === 0 && initialCalls.length > 0
    const message = queued ? { tool_calls: initialCalls }
      : await model.complete({ messages, tools: definitions, signal })
    signal.throwIfAborted()
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : []
    if (!calls.length) {
      return {
        content: context?.toolset?.startsWith('tau-')
          ? `<execution_receipt committed_operations="${committedOperations}" authority="runtime">${committedOperations ? 'Operation tool(s) actually committed after approval.' : 'No data-changing operation was committed by this task. Do NOT report any update as completed.'}</execution_receipt>\n${String(message.content || lastContent || '已处理').trim()}`
          : String(message.content || lastContent || '已处理').trim(),
        data: lastData,
      }
    }
    if (!queued) messages.push({
      role: 'assistant',
      content: message.content || null,
      tool_calls: calls,
    })
    for (const [index, call] of calls.entries()) {
      signal.throwIfAborted()
      const name = String(call?.function?.name || '')
      if (!allowed.has(name)) {
        throw new Error(`Customer service Agent selected unknown tool: ${name}`)
      }
      const args = toolArguments(call)
      if (name === 'ask_customer') {
        if (typeof args.question !== 'string' || !args.question.trim()) throw new Error('Missing customer question')
        const input = new CustomerInputNeeded(args.question.trim(), messages, call.id, calls.slice(index + 1))
        input.committedOperations = committedOperations
        throw input
      }
      onToolCall?.({ name, args })
      const result = await tools.call(name, args, { signal })
      lastContent = result.content
      lastData = result.data || lastData
      signal.throwIfAborted()
      if (result.data?.needsApproval) {
        const approval = result.data.approval
        if (!approval?.token || !approval.preview) throw new Error('Missing structured approval')
        const approvalNeeded = new ApprovalNeeded(result.content, {
          name, args, token: approval.token, toolCallId: call.id,
          remainingCalls: calls.slice(index + 1),
        }, messages)
        approvalNeeded.committedOperations = committedOperations
        throw approvalNeeded
      }
      if (result.data?.operationCommitted || result.data?.changed === true) committedOperations += 1
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
  constructor({ tools, model = new DashScopeServiceModel(), approvalTtlMs = 5 * 60 * 1000 }) {
    if (!tools?.list || !tools?.call) {
      throw new TypeError('Customer service Agent requires an MCP tool client')
    }
    if (!model?.complete) throw new TypeError('Customer service Agent requires a chat model')
    this.tools = tools
    this.model = model
    this.controllers = new Map()
    this.history = new AgentHistory()
    this.conversationId = null
    // 每个 taskId 单独保存预览、原工具参数和令牌；上下文不作为授权键。
    this.suspended = new Map()
    this.activeRuns = new Map()
    this.approvalTtlMs = approvalTtlMs
    this.resetting = false
  }

  async execute(requestContext, eventBus) {
    const { taskId, contextId } = requestContext
    if (this.activeRuns.has(taskId)) throw new Error('Task is already executing')
    const controller = new AbortController()
    const done = Promise.withResolvers()
    this.controllers.set(taskId, controller)
    this.activeRuns.set(taskId, { done: done.promise, eventBus, contextId })
    const objective = inputText(requestContext.userMessage)
    let history = null

    // 只允许恢复同一 taskId 的批准，不重新拼接自然语言来决定是否提交。
    const pending = this.suspended.get(taskId)
    const resumed = Boolean(pending)
    if (resumed) {
      clearTimeout(pending.timer)
      this.suspended.delete(taskId)
    }

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

      if (this.tools.conversationId) {
        const id = await this.tools.conversationId({ signal: controller.signal })
        controller.signal.throwIfAborted()
        if (this.conversationId !== null && this.conversationId !== id) {
          this.history = new AgentHistory()
          for (const entry of this.suspended.values()) clearTimeout(entry.timer)
          this.suspended.clear()
          for (const [otherTaskId, other] of this.controllers) {
            if (otherTaskId !== taskId) other.abort()
          }
        }
        this.conversationId = id
      }
      history = this.history

      eventBus.publish(statusUpdate(taskId, contextId, TaskState.TASK_STATE_WORKING,
        resumed ? '收到客户答复，继续处理。' : '正在处理。'))

      if (this.resetting) throw new Error('客服正在重置，请稍后重试。')
      if (requestContext.task && !pending) {
        throw new Error('原任务已结束或确认已过期，请重新发起操作。')
      }
      if (pending && pending.contextId !== contextId) {
        await this.tools.revokeApproval?.(pending.operation?.token)
        throw new Error('任务上下文不匹配，请重新发起操作。')
      }

      // 授权是协议层的决定，不让模型从自然语言里猜测。
      // 缺少结构化同意也按未批准处理（fail closed）。
      const inputResponse = requestContext.userMessage?.metadata?.qwenAudioInputResponse
      if (resumed && pending.kind !== 'customer-input' && (inputResponse?.kind !== 'authorization' || inputResponse.action !== 'accept')) {
        await this.tools.revokeApproval?.(pending.operation?.token)
        history.append(contextId, `${pending.objective}\n\n客户补充：${objective}`,
          '客户未批准待确认操作，未执行数据变更。')
        eventBus.publish(statusUpdate(taskId, contextId,
          TaskState.TASK_STATE_COMPLETED, '未获得客户批准，这笔操作没有执行。'))
        return
      }

      // 批准后提交已保存的操作，不再让模型选择工具、改写参数或读取令牌。
      if (resumed && pending.kind === 'customer-input') {
        if (Date.now() - pending.at >= this.approvalTtlMs) throw new Error('补充信息请求已过期，请重新发起操作。')
        if (inputResponse?.action === 'cancel') {
          history.append(contextId, `${pending.objective}\n\n客户补充：${objective}`,
            '客户取消了待补充信息的任务。')
          eventBus.publish(statusUpdate(taskId, contextId, TaskState.TASK_STATE_CANCELED, '任务已取消。'))
          return
        }
        pending.messages.push({ role: 'tool', tool_call_id: pending.callId,
          content: `Customer response (information only, NOT write authorization): ${objective}` })
        const output = await runServiceAgent({ objective: pending.objective, model: this.model,
          tools: this.tools, signal: controller.signal, initialMessages: pending.messages,
          initialCalls: pending.remainingCalls, committedOperations: pending.committedOperations })
        history.append(contextId, `${pending.objective}\n\n客户补充：${objective}`, output.content)
        eventBus.publish(statusUpdate(taskId, contextId, TaskState.TASK_STATE_COMPLETED, output.content))
        return
      }
      if (resumed) {
        if (Date.now() - pending.at >= this.approvalTtlMs) {
          await this.tools.revokeApproval?.(pending.operation.token)
          throw new Error('确认已过期，请重新发起操作。')
        }
        const { name, args, token } = pending.operation
        controller.signal.throwIfAborted()
        eventBus.publish(statusUpdate(taskId, contextId, TaskState.TASK_STATE_WORKING, '正在办理。'))
        const output = await this.tools.call(name, { ...args, approval_token: token }, { signal: controller.signal })
        controller.signal.throwIfAborted()
        if (output.data?.needsApproval) throw new Error('批准已失效，请重新发起操作。')
        // 继续原任务剩余步骤；模型只看已提交结果，仍看不到令牌。
        // 下一笔写操作仍必须独立取得预览和批准。
        const messages = pending.messages
        messages.push({ role: 'tool', tool_call_id: pending.operation.toolCallId, content: output.content })
        const finalOutput = await runServiceAgent({
          objective: pending.objective, model: this.model, tools: this.tools,
          signal: controller.signal, initialMessages: messages,
          initialCalls: pending.operation.remainingCalls, initialOutput: output,
          committedOperations: (pending.committedOperations || 0) + 1,
        })
        history.append(contextId, `${pending.objective}\n\n客户补充：${objective}`, finalOutput.content)
        eventBus.publish(statusUpdate(taskId, contextId, TaskState.TASK_STATE_COMPLETED, finalOutput.content))
        return
      }

      // 只有新任务进入模型；恢复执行走上面的确定性提交。
      const output = await runServiceAgent({
        objective,
        history: history.messages(contextId),
        model: this.model,
        tools: this.tools,
        signal: controller.signal,
        onToolCall: () => {
          eventBus.publish(statusUpdate(taskId, contextId,
            TaskState.TASK_STATE_WORKING, '正在查询和处理，请稍等。'))
        },
      })

      history.append(contextId, objective, output.content)
      eventBus.publish(statusUpdate(taskId, contextId,
        TaskState.TASK_STATE_COMPLETED, output.content))
    } catch (error) {
      if (error instanceof CustomerInputNeeded) {
        const entry = { kind: 'customer-input', contextId, eventBus,
          objective: pending?.objective || objective, messages: error.messages,
          committedOperations: error.committedOperations,
          callId: error.callId, remainingCalls: error.remainingCalls, at: Date.now() }
        entry.timer = setTimeout(() => { this.cancelTask(taskId).catch(() => {}) }, this.approvalTtlMs)
        entry.timer.unref?.()
        this.suspended.set(taskId, entry)
        eventBus.publish(statusUpdate(taskId, contextId, TaskState.TASK_STATE_INPUT_REQUIRED, error.prompt))
        return
      }
      if (error instanceof ApprovalNeeded) {
        // 内部操作和客户预览分开保存，令牌不进入 A2A 文本或模型消息。
        const suspendedEntry = {
          contextId,
          eventBus,
          objective: pending?.objective || objective,
          committedOperations: error.committedOperations,
          preview: error.preview,
          operation: error.operation,
          messages: error.messages,
          at: Date.now(),
        }
        suspendedEntry.timer = setTimeout(() => {
          this.cancelTask(taskId).catch(() => {})
        }, this.approvalTtlMs)
        suspendedEntry.timer.unref?.()
        this.suspended.set(taskId, suspendedEntry)
        // 【关键一步】TASK_STATE_AUTH_REQUIRED + 一条带预览的消息。
        // Gateway 侧的 a2a-backend-adapter 会把它转成 auth_required 状态，
        // prompt 取自这条消息的文本，再由前台语音念给客户。
        eventBus.publish(statusUpdate(taskId, contextId,
          TaskState.TASK_STATE_AUTH_REQUIRED, error.preview,
          { qwenAudioApprovalExpiresAt: suspendedEntry.at + this.approvalTtlMs }))
        return
      }
      if (controller.signal.aborted) {
        history?.append(contextId, pending?.objective || objective,
          '任务已取消；已执行操作的当前状态需通过工具核实。')
        eventBus.publish(statusUpdate(taskId, contextId,
          TaskState.TASK_STATE_CANCELED, '任务已取消。'))
        return
      }
      history?.append(contextId, pending?.objective || objective,
        `任务未完成：${error.message || '处理失败'}。已执行操作的当前状态需通过工具核实。`)
      eventBus.publish(statusUpdate(taskId, contextId,
        TaskState.TASK_STATE_FAILED, error.message || '处理失败。'))
    } finally {
      this.controllers.delete(taskId)
      this.activeRuns.delete(taskId)
      done.resolve()
    }
  }

  async cancelTask(taskId, eventBus) {
    const pending = this.suspended.get(taskId)
    if (pending) {
      clearTimeout(pending.timer)
      this.suspended.delete(taskId)
      try {
        await this.tools.revokeApproval?.(pending.operation?.token)
      } finally {
        this.history.append(pending.contextId, pending.objective,
          '客户取消了待确认任务，未继续执行该操作。')
        const bus = eventBus || pending.eventBus
        bus?.publish(statusUpdate(taskId, pending.contextId,
          TaskState.TASK_STATE_CANCELED, '任务已取消。'))
      }
    }
    this.controllers.get(taskId)?.abort()
  }

  async reset() {
    if (this.resetting) throw new Error('Reset already in progress')
    this.resetting = true
    try {
      const runs = [...this.activeRuns.values()].map(run => run.done)
      await Promise.all([...new Set([...this.suspended.keys(), ...this.controllers.keys()])]
        .map(taskId => this.cancelTask(taskId)))
      let timer
      try {
        await Promise.race([
          Promise.all(runs),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Task cleanup timed out')), 5_000) }),
        ])
      } finally { clearTimeout(timer) }
      this.history = new AgentHistory()
      this.conversationId = null
    } finally { this.resetting = false }
  }
}
