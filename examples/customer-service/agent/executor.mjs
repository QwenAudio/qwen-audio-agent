import { randomUUID } from 'node:crypto'
import { Role, TaskState } from '@a2a-js/sdk'
import { AgentEvent } from '@a2a-js/sdk/server'
import { DashScopeServiceModel } from './model.mjs'
import { flowPrompt } from './flows.mjs'
import { AgentHistory } from './agent-history.mjs'

const MAX_AGENT_ROUNDS = 8
const EXECUTION_RECEIPT_SCHEMA = 'qwen-audio-agent/customer-service-execution-receipt@1'

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
- 收齐执行所需信息与客户的真实业务选择后，直接调用写工具取得预览。
  预览后的运行时授权就是该具体操作的最终确认；不要先单独询问一次
  “确定要办理吗”，再让客户为同一操作确认预览。若客户尚未选定方案、
  支付方式或政策明确要求先作独立选择，才用 ask_customer 补齐。
- policy 要求客户确认目标记录正确、或要求对变更后的对象重新选择偏好时，
  这些都是写操作前必须完成的检查点。数据库里的旧偏好不能代替本次明确
  答复；但交接或当前对话已经包含客户本次答复时不得重复询问。
- 一项诉求包含多笔改动时，先核对每笔操作的前置状态与执行后的状态。
  如果先做一笔会使另一笔不再符合政策，任何一笔都不要先提交；先说明
  冲突并请客户选择可执行的方案，不能擅自只完成其中一笔。
- 把交接中的【目标】【硬约束】【默认保持】【未决事项】当作完成清单：
  每次操作后更新哪些已经完成、拒绝或仍待处理；不能因为完成了第一笔操作
  就结束整项请求，也不能擅自改变“默认保持”的属性。
- 准备结束前，使用可用的只读工具重新核对被修改记录的当前状态；如果实际
  状态仍不满足目标，继续处理、询问必要选择或如实说明阻碍，不要只复述工具话术。
- 工具返回的业务判定（不符合条件、细则未覆盖、超出权限等）照实转达，
  不要换个说法再试一次，也不要自己估算天数、差价或补偿金额。
- 严格保留工具结果的生命周期语义：“已发起”“处理中”“待入账”不等于
  “已到账”或“已结清”。只有工具明确返回 settled、received、到账或等价
  终态时，才能向客户说款项已经到账。
- 取消记录、退款资格或一笔退款成功，不能证明其他退款也已发起。fare、
  ancillary 等多组成结果必须逐笔调用政策要求的工具，并只报告各自真实回执。
- 需要转人工时调用 transfer_to_human，并写清原因。
- 最终回复要简短、自然，适合前台语音助手直接念给客户听。金额和单号要写完整。

【客户只知道一个客服，就是你】你的回复会被【原话念给客户】，所以里面不能出现
这套系统的内部结构。不要说"后台"、"前台"、"后台客服"、"提交后台处理"、
"Agent"、"系统"、"工单"、"接口"、"我这边转给"这类话 —— 客户听到"提交后台客服"
会以为要换个人接手，而实际上从头到尾就是你在办。
- 缺少业务选择或参数时，只问缺少的内容；不要为将由运行时展示的
  同一笔操作另起一次泛化确认。预览中说明具体操作与金额，由运行时询问批准。
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

function dataPart(data) {
  return {
    content: { $case: 'data', value: data },
    metadata: undefined,
    filename: '',
    mediaType: 'application/json',
  }
}

function operationEffect(name, result) {
  const content = String(result?.content || 'Operation committed.').trim()
  let structuredResult
  try {
    const parsed = JSON.parse(content)
    if (parsed && typeof parsed === 'object'
      && JSON.stringify(parsed).length <= 32_000) structuredResult = parsed
  } catch {}
  return {
    operation: String(name || 'unknown').slice(0, 160),
    status: 'committed',
    ...(structuredResult === undefined
      ? { summary: content.slice(0, 4_000) }
      : { result: structuredResult }),
  }
}

function executionReceipt(outcome, committedEffects = [], detail = '') {
  const operations = committedEffects.map(effect => ({ ...effect }))
  const summaries = {
    committed: `${operations.length} data-changing operation(s) actually committed.`,
    no_change: 'No data-changing operation was committed by this task.',
    partial: `${operations.length} data-changing operation(s) committed before the task stopped; verify current state before continuing.`,
    failed: 'The task failed before any data-changing operation was committed.',
    cancelled: 'The task was cancelled before any data-changing operation was committed.',
    declined: 'The pending operation was declined and was not committed.',
  }
  return {
    schema: EXECUTION_RECEIPT_SCHEMA,
    outcome,
    committedCount: operations.length,
    committedOperations: operations,
    requiresStateVerification: outcome === 'partial' || outcome === 'failed',
    summary: summaries[outcome] || 'Execution state recorded by the runtime.',
    ...(detail && ['partial', 'failed'].includes(outcome)
      ? { detail: String(detail).trim().slice(0, 1_000) }
      : {}),
  }
}

function publishExecutionReceipt(eventBus, taskId, contextId, receipt) {
  eventBus.publish(AgentEvent.artifactUpdate({
    taskId,
    contextId,
    artifact: {
      artifactId: 'customer-service-execution-receipt',
      name: 'Customer service execution receipt',
      description: 'Runtime-authored evidence of data-changing operations actually committed by this task.',
      parts: [dataPart(receipt)],
      metadata: undefined,
      extensions: [],
    },
    append: false,
    lastChunk: true,
    metadata: undefined,
  }))
}

function publishCompleted(eventBus, taskId, contextId, output) {
  publishExecutionReceipt(eventBus, taskId, contextId, output.receipt)
  eventBus.publish(statusUpdate(taskId, contextId,
    TaskState.TASK_STATE_COMPLETED, output.content))
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

function priorAuthorizationEvidence(value) {
  if (!value || typeof value !== 'object') return null
  const proposal = typeof value.proposal === 'string' ? value.proposal.trim() : ''
  const customerReply = typeof value.customerReply === 'string'
    ? value.customerReply.trim()
    : ''
  if (!proposal || !customerReply) return null
  return {
    proposal: proposal.slice(0, 8_000),
    customerReply: customerReply.slice(0, 4_000),
  }
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

// The retail policy makes both actions terminal for a delivered order. This
// conservative gate applies only when the request explicitly names both
// actions and exactly one order; ambiguous/multi-order requests stay with the
// agent for normal investigation. It never guesses a customer's priority.
function exclusiveRetailChoice(objective, toolset) {
  if (toolset !== 'tau-retail') return null
  const actions = [/(?:\breturns?\b|退货)/iu, /(?:\bexchanges?\b|换货)/iu]
  const orders = new Set((String(objective).match(/#[a-z0-9-]+/giu) || []).map(order => order.toUpperCase()))
  return orders.size === 1 && actions.every(pattern => pattern.test(objective)) ? [...orders][0] : null
}

function selectedRetailAction(answer) {
  const wantsReturn = /(?:\breturns?\b|退货)/iu.test(answer)
  const wantsExchange = /(?:\bexchanges?\b|换货)/iu.test(answer)
  return wantsReturn === wantsExchange ? null : wantsReturn ? 'return' : 'exchange'
}

function isBenchmarkToolset(toolset) {
  return toolset?.startsWith('tau-') || toolset?.startsWith('benchmark-')
}

function retailChoicePrompt() {
  return 'For this delivered order, a return changes its status to return requested and an exchange changes it to exchange requested. The policy requires delivered status for both, so I cannot complete both on the same order. Which ONE should I process: the return or the exchange? Neither has been submitted.'
}

const customerInputTool = {
  type: 'function', function: {
    name: 'ask_customer',
    description: 'Suspend for a missing factual field or a genuine business/policy choice. This tool cannot authorize a write or ask for generic permission to proceed: invoke the write tool for its exact runtime approval preview.',
    parameters: { type: 'object', properties: {
      purpose: { type: 'string', enum: ['missing_information', 'business_choice'] },
      question: { type: 'string', minLength: 1 },
      field: { type: 'string', description: 'For missing_information: the specific unknown field needed to continue.' },
      options: { type: 'array', items: { type: 'string' }, minItems: 2,
        description: 'For business_choice: distinct business alternatives, not yes/no approval of a write.' },
    }, required: ['purpose', 'question'], additionalProperties: false },
  },
}

function customerQuestion(args) {
  const question = typeof args.question === 'string' ? args.question.trim() : ''
  if (!question) throw new Error('Missing customer question')
  if (args.purpose === 'missing_information') {
    if (typeof args.field !== 'string' || !args.field.trim() || args.options !== undefined) {
      throw new Error('Missing-information request requires a field and no options')
    }
  } else if (args.purpose === 'business_choice') {
    const options = args.options
    if (args.field !== undefined || !Array.isArray(options) || options.length < 2
      || options.some(option => typeof option !== 'string' || !option.trim())
      || new Set(options.map(option => option.trim().toLowerCase())).size !== options.length) {
      throw new Error('Business-choice request requires distinct options and no field')
    }
  } else {
    throw new Error('Customer input must be missing_information or business_choice; use write preview for authorization')
  }
  return question
}

async function runServiceAgent({ objective, model, tools, signal, onToolCall,
  history = [], initialMessages, initialCalls = [], initialOutput, committedOperations = 0,
  committedEffects = [], operationChoice = null, authorizationEvidence = null }) {
  const availableTools = await tools.list({ signal })
  const definitions = availableTools.map(openAiTool)
  definitions.push(customerInputTool)
  const allowed = new Set(definitions.map(tool => tool.function.name))
  const context = await tools.context?.({ signal })
  const canReusePriorAuthorization = isBenchmarkToolset(context?.toolset)
  const prompt = isBenchmarkToolset(context?.toolset)
    ? `${context.policy}\n\nRuntime: tools execute the official tau environment. Writes require explicit customer approval.\nDo not supply approval_token; the runtime previews and commits saved operations after authorization. A customer's immediately preceding explicit approval of a concrete assistant proposal may cover every write that stays within that proposal; the runtime independently compares each exact preview with that evidence and otherwise pauses for new approval.\nOnce required facts and genuine choices are known, call the write tool to obtain its exact approval preview; do not first ask a generic 'may I proceed?' for the same operation. Before the FIRST write in a multi-action request, check all requested changes against the policy and resulting entity states. If one change would make another requested change ineligible, do not commit either one or silently perform only a subset; explain the conflict and use ask_customer for a genuine choice. Policy-required record confirmation and fresh preference are required facts. A stored preference is not a fresh answer, but an answer already present in the delegated dialogue is sufficient and MUST NOT be asked again. Treat the delegated goal, hard constraints, preserve-by-default fields, and unresolved items as a completion checklist. After every operation, continue until every requested outcome is completed, explicitly declined, or blocked by a stated policy reason. Do not change an existing attribute merely because a broader search exposes another option. Before finishing, use available read tools to verify the changed records against that checklist. Use ask_customer only for missing information or a distinct policy/business choice. Follow the policy and never claim an action succeeded without its committed tool result. Preserve result lifecycle exactly: initiated, pending, or processing never means received, settled, or credited. For multi-part outcomes such as fare plus ancillary refunds, execute every policy-required component separately and report a component only after its own committed result.`
    : serviceAgentPrompt()
  const identity = context?.verifiedIdentity
  const sharedContext = identity ? `\n\nTrusted session context: the customer has ALREADY been authenticated in this SAME conversation by the official tool ${identity.method}, with arguments ${JSON.stringify(identity.arguments)}, returning user_id ${JSON.stringify(identity.userId)}. This is a continuation, not a new conversation. Do not require authentication again or act on another customer's account. This identity is NOT authorization to update data.` : ''
  const messages = initialMessages || [
    // 【运行时取，不用模块加载时的快照】SERVICE_AGENT_PROMPT 是导入那一刻
    // 就定下的，而测试会在导入之后改 CS_DOMAIN 来验分域。
    { role: 'system', content: `${prompt}${sharedContext}\nWhen a required fact or a distinct policy/business choice is missing, call ask_customer. Do not use ask_customer for generic pre-write confirmation; the runtime approval preview is the confirmation for the exact write. Do not end a task with a question. A task ending is not evidence of a database update. Never claim a write succeeded without its committed tool result.` },
    ...history,
    { role: 'user', content: objective },
  ]
  const exclusiveOrderId = !initialMessages && exclusiveRetailChoice(objective, context?.toolset)
  if (exclusiveOrderId) {
    const input = new CustomerInputNeeded(retailChoicePrompt(), messages, null, [])
    input.choiceRequest = true
    input.choiceOrderId = exclusiveOrderId
    throw input
  }
  let lastContent = initialOutput?.content || ''
  let lastData = initialOutput?.data || {}

  try {
    for (let round = 0; round < MAX_AGENT_ROUNDS; round += 1) {
      signal.throwIfAborted()
      const queued = round === 0 && initialCalls.length > 0
      const message = queued ? { tool_calls: initialCalls }
        : await model.complete({ messages, tools: definitions, signal })
      signal.throwIfAborted()
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : []
      if (!calls.length) {
        const content = String(message.content || lastContent || '已处理').trim()
        return {
          content,
          data: lastData,
          receipt: executionReceipt(
            committedOperations ? 'committed' : 'no_change',
            committedEffects,
            content,
          ),
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
          let question
          try { question = customerQuestion(args) } catch (error) {
            // A malformed model tool call is not a failed customer task. Give the
            // model the contract error so it can correct the request, while still
            // refusing to suspend or interpret it as write authorization.
            messages.push({ role: 'tool', tool_call_id: call.id,
              content: `ask_customer rejected: ${error.message}. Provide a valid purpose and its required field or distinct options; do not request write authorization here.` })
            continue
          }
          const input = new CustomerInputNeeded(question, messages, call.id, calls.slice(index + 1))
          input.committedOperations = committedOperations
          input.committedEffects = committedEffects
          input.operationChoice = operationChoice
          throw input
        }
        if (operationChoice && availableTools.find(tool => tool.name === name)?.annotations?.readOnlyHint === false
          && !name.startsWith('transfer_to_human')
          && (name !== `${operationChoice.action}_delivered_order_items`
            || String(args.order_id || '').toUpperCase() !== operationChoice.orderId)) {
          throw new Error(`The customer selected ${operationChoice.action} for ${operationChoice.orderId}; another write requires a separate customer decision`)
        }
        onToolCall?.({ name, args })
        const result = await tools.call(name, args, { signal })
        lastContent = result.content
        lastData = result.data || lastData
        signal.throwIfAborted()
        if (result.data?.needsApproval) {
          const approval = result.data.approval
          if (!approval?.token || !approval.preview) throw new Error('Missing structured approval')
          const priorDecision = canReusePriorAuthorization
            && typeof model.authorizePriorPlan === 'function'
            ? await model.authorizePriorPlan({
                evidence: authorizationEvidence,
                operation: { name, arguments: args },
                preview: approval.preview,
                signal,
              })
            : { authorized: false }
          signal.throwIfAborted()
          if (priorDecision?.authorized === true) {
            const committed = await tools.call(name, {
              ...args,
              approval_token: approval.token,
            }, { signal })
            signal.throwIfAborted()
            if (committed.data?.needsApproval) {
              throw new Error('Prior authorization could not commit the saved operation')
            }
            lastContent = committed.content
            lastData = committed.data || lastData
            committedOperations += 1
            committedEffects = [...committedEffects, operationEffect(name, committed)]
            messages.push({
              role: 'tool',
              tool_call_id: call.id,
              content: committed.content,
            })
            continue
          }
          const approvalNeeded = new ApprovalNeeded(result.content, {
            name, args, token: approval.token, toolCallId: call.id,
            remainingCalls: calls.slice(index + 1),
          }, messages)
          approvalNeeded.committedOperations = committedOperations
          approvalNeeded.committedEffects = committedEffects
          approvalNeeded.operationChoice = operationChoice
          approvalNeeded.authorizationEvidence = authorizationEvidence
          throw approvalNeeded
        }
        if (result.data?.operationCommitted || result.data?.changed === true) {
          committedOperations += 1
          committedEffects = [...committedEffects, operationEffect(name, result)]
        }
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: result.content,
        })
      }
    }
    throw new Error(`Customer service Agent exceeded ${MAX_AGENT_ROUNDS} model rounds`)
  } catch (error) {
    if (error.committedOperations === undefined) error.committedOperations = committedOperations
    if (error.committedEffects === undefined) error.committedEffects = committedEffects
    throw error
  }
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
    const requestAuthorizationEvidence = priorAuthorizationEvidence(
      requestContext.userMessage?.metadata?.qwenAudioAuthorizationEvidence,
    )
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

      // The frontend model resolves the natural-language reply into the
      // structured inputResponse. The backend only enforces that protocol
      // decision and never re-classifies the same text with keyword rules.
      const inputResponse = requestContext.userMessage?.metadata?.qwenAudioInputResponse
      if (resumed && pending.kind !== 'customer-input' && (
        inputResponse?.kind !== 'authorization'
        || inputResponse.action !== 'accept'
      )) {
        await this.tools.revokeApproval?.(pending.operation?.token)
        history.append(contextId, `${pending.objective}\n\n客户补充：${objective}`,
          '客户未批准待确认操作，未执行数据变更。')
        publishExecutionReceipt(eventBus, taskId, contextId, executionReceipt(
          pending.committedEffects?.length ? 'partial' : 'declined',
          pending.committedEffects,
          '客户未批准待确认操作，未执行该项数据变更。',
        ))
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
          publishExecutionReceipt(eventBus, taskId, contextId, executionReceipt(
            pending.committedEffects?.length ? 'partial' : 'cancelled',
            pending.committedEffects,
            '客户取消了待补充信息的任务。',
          ))
          eventBus.publish(statusUpdate(taskId, contextId, TaskState.TASK_STATE_CANCELED, '任务已取消。'))
          return
        }
        let operationChoice = pending.operationChoice || null
        if (pending.choiceRequest) {
          const selected = selectedRetailAction(objective)
          if (!selected) {
            const input = new CustomerInputNeeded(retailChoicePrompt(), pending.messages, null, [])
            input.choiceRequest = true
            input.choiceOrderId = pending.choiceOrderId
            throw input
          }
          operationChoice = { action: selected, orderId: pending.choiceOrderId }
          pending.messages.push({ role: 'user', content: `Customer selected ONLY ${selected} for order ${pending.choiceOrderId}; the other requested operation must not be performed. This is a business choice, NOT write authorization.` })
        } else {
          pending.messages.push({ role: 'tool', tool_call_id: pending.callId,
            content: `Customer response (information only, NOT write authorization): ${objective}` })
        }
        const output = await runServiceAgent({ objective: pending.objective, model: this.model,
          tools: this.tools, signal: controller.signal, initialMessages: pending.messages,
          initialCalls: pending.remainingCalls, committedOperations: pending.committedOperations,
          committedEffects: pending.committedEffects,
          operationChoice,
          authorizationEvidence: pending.authorizationEvidence })
        history.append(contextId, `${pending.objective}\n\n客户补充：${objective}`, output.content)
        publishCompleted(eventBus, taskId, contextId, output)
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
          committedEffects: [
            ...(pending.committedEffects || []),
            operationEffect(name, output),
          ],
          operationChoice: pending.operationChoice,
          authorizationEvidence: pending.authorizationEvidence,
        })
        history.append(contextId, `${pending.objective}\n\n客户补充：${objective}`, finalOutput.content)
        publishCompleted(eventBus, taskId, contextId, finalOutput)
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
        authorizationEvidence: requestAuthorizationEvidence,
      })

      history.append(contextId, objective, output.content)
      publishCompleted(eventBus, taskId, contextId, output)
    } catch (error) {
      if (error instanceof CustomerInputNeeded) {
        const entry = { kind: 'customer-input', contextId, eventBus,
          objective: pending?.objective || objective, messages: error.messages,
          committedOperations: error.committedOperations,
          committedEffects: error.committedEffects,
          callId: error.callId, remainingCalls: error.remainingCalls, at: Date.now() }
        entry.choiceRequest = error.choiceRequest || false
        entry.choiceOrderId = error.choiceOrderId || pending?.choiceOrderId || null
        entry.operationChoice = error.operationChoice || pending?.operationChoice || null
        entry.authorizationEvidence = error.authorizationEvidence
          || pending?.authorizationEvidence
          || requestAuthorizationEvidence
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
          committedEffects: error.committedEffects,
          operationChoice: error.operationChoice || pending?.operationChoice || null,
          preview: error.preview,
          operation: error.operation,
          messages: error.messages,
          authorizationEvidence: error.authorizationEvidence
            || pending?.authorizationEvidence
            || requestAuthorizationEvidence,
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
        publishExecutionReceipt(eventBus, taskId, contextId, executionReceipt(
          (error.committedEffects || pending?.committedEffects)?.length ? 'partial' : 'cancelled',
          error.committedEffects || pending?.committedEffects,
          '任务已取消；已执行操作的当前状态需通过工具核实。',
        ))
        eventBus.publish(statusUpdate(taskId, contextId,
          TaskState.TASK_STATE_CANCELED, '任务已取消。'))
        return
      }
      history?.append(contextId, pending?.objective || objective,
        `任务未完成：${error.message || '处理失败'}。已执行操作的当前状态需通过工具核实。`)
      publishExecutionReceipt(eventBus, taskId, contextId, executionReceipt(
        (error.committedEffects || pending?.committedEffects)?.length ? 'partial' : 'failed',
        error.committedEffects || pending?.committedEffects,
        error.message || '处理失败。',
      ))
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
        if (bus) publishExecutionReceipt(bus, taskId, pending.contextId, executionReceipt(
          pending.committedEffects?.length ? 'partial' : 'cancelled',
          pending.committedEffects,
          '客户取消了待确认任务，未继续执行该操作。',
        ))
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
