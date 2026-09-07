import {
  spawnThinkingTool,
} from '../spawn-thinking-tool.mjs'

export { SPAWN_THINKING_TOOL_NAME } from '../spawn-thinking-tool.mjs'
export const CANCEL_AGENT_TASK_TOOL_NAME = 'cancel_agent_task'
export const GET_AGENT_TASK_STATUS_TOOL_NAME = 'get_agent_task_status'
export const RESPOND_PERMISSION_TOOL_NAME = 'respond_permission'
export const PERMISSION_RESPONSE_CAPABILITY = 'permission.respond'
export const RESPOND_AGENT_INPUT_TOOL_NAME = 'respond_agent_input'
export const BACKEND_INPUT_RESPONSE_CAPABILITY = 'backend.input.respond'

const cancelAgentTaskTool = {
  type: 'function',
  function: {
    name: CANCEL_AGENT_TASK_TOOL_NAME,
    description: '取消用户此前开始、目前仍可取消的异步工作、定时任务或提醒。用户明确要求取消或停止时必须调用，不要只口头答应。循环提醒优先使用回执中的 series_id 取消整组；普通工作使用 task_id。同时存在多项且目标不能可靠确定时，先调用 get_agent_task_status 列出工作。不要重复取消已经处理的工作。',
    parameters: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: '要取消的 task_id。仅使用系统返回的 ID，不得猜造；省略则取消当前语音会话最近创建且仍可取消的一项。',
        },
        series_id: {
          type: 'string',
          description: '循环提醒创建回执返回的 series_id。用户要求停止整组循环提醒时使用；不得猜造，也不要与 task_id 同时填写。',
        },
        all: {
          type: 'boolean',
          description: '用户明确要求取消当前会话中的全部工作、定时任务和提醒时设为 true；此时不要填写 task_id 或 series_id。',
        },
      },
      additionalProperties: false,
    },
  },
}

const getAgentTaskStatusTool = {
  type: 'function',
  function: {
    name: GET_AGENT_TASK_STATUS_TOOL_NAME,
    description: '仅当用户主动询问此前工作的状态、进度、阶段结果或列表时调用；不得因 spawn_thinking 的 accepted 或 duplicate 回执自动查询。用户询问此前工作时不要改用 spawn_thinking。可列出当前会话中的工作、定时任务和提醒。',
    parameters: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: '要查询的 task_id。仅在当前对话或先前工具结果已明确给出时填写，不得猜造；省略时查询当前语音会话最近的工作。',
        },
        question: {
          type: 'string',
          description: '用户本轮对任务状态、进度或阶段结果的原始问题。尽量忠实保留，不要自行改写成另一项任务；省略时系统会使用本轮语音转写。',
        },
        list_all: {
          type: 'boolean',
          description: '用户明确要求列出有哪些工作、定时任务或提醒时设为 true；查询“刚才那个”时不要设置。',
        },
      },
      additionalProperties: false,
    },
  },
}

const respondPermissionTool = {
  type: 'function',
  function: {
    name: RESPOND_PERMISSION_TOOL_NAME,
    description: '回复当前正在等待用户决定的权限请求。结合刚提出的具体操作、请求允许的选项和用户本轮自然表达判断，不要依赖固定关键词：普通肯定表达选择 once；仅当请求允许且用户明确表示本会话以后都允许时选择 always；明确拒绝时选择 reject；意思不明确时不要调用并继续询问。不得猜测权限来源、代替用户决定或要求固定口令。',
    parameters: {
      type: 'object',
      properties: {
        permission_id: {
          type: 'string',
          description: '待确认权限请求的 ID，必须来自 Gateway 提供的当前权限请求。',
        },
        task_id: {
          type: 'string',
          description: '权限请求关联的工作 ID；仅当 Gateway 在请求中提供时原样传入。',
        },
        decision: {
          type: 'string',
          enum: ['once', 'always', 'reject'],
          description: 'once 仅允许当前操作；always 仅在请求明确允许时表示本会话后续同类请求也允许；reject 拒绝当前操作。',
        },
      },
      required: ['permission_id', 'decision'],
      additionalProperties: false,
    },
  },
}

const respondAgentInputTool = {
  type: 'function',
  function: {
    name: RESPOND_AGENT_INPUT_TOOL_NAME,
    description: '把用户对当前后台追问的回答交回同一项工作，使其继续执行。仅在系统提供真实的后台输入请求时可用；不得新建工作或猜造 task_id。用户拒绝回答时选择 decline，要求取消这次交互时选择 cancel。',
    parameters: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: '等待补充输入的工作 ID，必须来自当前后台输入请求。',
        },
        action: {
          type: 'string',
          enum: ['accept', 'decline', 'cancel'],
          description: 'accept 提交回答并继续；decline 拒绝提供；cancel 取消这次交互。',
        },
        text: {
          type: 'string',
          description: '用户要交给后台的自然语言回答。action=accept 时填写。',
        },
        values: {
          type: 'object',
          description: '可选的结构化表单回答；字段必须来自请求中提供的 schema。',
          additionalProperties: true,
        },
      },
      required: ['task_id', 'action'],
      additionalProperties: false,
    },
  },
}

export const agentTaskToolEntries = [
  {
    definition: spawnThinkingTool,
    policy: { mode: 'background', repeatHandling: 'handler' },
  },
  { definition: cancelAgentTaskTool, policy: { mode: 'control' } },
  { definition: getAgentTaskStatusTool, policy: { mode: 'control' } },
  {
    definition: respondPermissionTool,
    policy: {
      mode: 'control',
      requiredCapabilities: [PERMISSION_RESPONSE_CAPABILITY],
    },
  },
  {
    definition: respondAgentInputTool,
    policy: {
      mode: 'control',
      requiredCapabilities: [BACKEND_INPUT_RESPONSE_CAPABILITY],
    },
  },
]

export function agentTaskToolHandlers(runtime) {
  return {
    spawn_thinking: context => runtime.executeSpawnThinkingToolCall(context),
    [CANCEL_AGENT_TASK_TOOL_NAME]: context => runtime.executeCancelToolCall(context),
    [GET_AGENT_TASK_STATUS_TOOL_NAME]: context => runtime.executeStatusToolCall(context),
    [RESPOND_PERMISSION_TOOL_NAME]: context => runtime.respondPermission(context),
    [RESPOND_AGENT_INPUT_TOOL_NAME]: context => runtime.respondAgentInput(context),
  }
}
