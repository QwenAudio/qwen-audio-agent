import {
  buildFrontendContext,
  loadFrontendPrompt,
} from '../conversation/frontend-agent-context.mjs'

export const SPAWN_THINKING_TOOL_NAME = 'spawn_thinking'
export const DELEGATE_TOOL_NAME = SPAWN_THINKING_TOOL_NAME
export const CANCEL_AGENT_TASK_TOOL_NAME = 'cancel_agent_task'
export const GET_AGENT_TASK_STATUS_TOOL_NAME = 'get_agent_task_status'
export const GET_CURRENT_TIME_TOOL_NAME = 'get_current_time'
export const USER_MEMORY_TOOL_NAME = 'user_memory'
export const RESPOND_AGENT_PERMISSION_TOOL_NAME = 'respond_agent_permission'

const delegateTool = {
  type: 'function',
  function: {
    name: DELEGATE_TOOL_NAME,
    description: '把明确的新执行或调查要求交给后台 Agent。需要当前信息、搜索、检查、工具、文件、屏幕、应用、代码、创作，或要求继续、修改已有工作时调用；询问此前工作的状态、进度、阶段产物或已经发现了什么统一改用 get_agent_task_status。缺少不可推断的核心目标时先问一个必要问题。可以按需先说一句具体行动预告，不要使用“好的、收到”等通用承接语。返回 accepted 只表示已受理；结合本轮已有发言判断是否还需回应，不重复确认或声称完成。',
    parameters: {
      type: 'object',
      properties: {
        objective: {
          type: 'string',
          description: '必须是已经可以执行的目标，忠实保留本轮用户要求并写明对象、动作、约束和期望结果，不得用“待用户说明主题”等占位内容启动空执行。仅在当前对话已经明确时消解“它、刚才那个”等指代；不要猜测或补造事实。后台 Agent 会同时收到近期对话和后台执行状态，因此这里是意图交接，不是对历史的替代。',
        },
      },
      required: ['objective'],
      additionalProperties: false,
    },
  },
}

const cancelAgentTaskTool = {
  type: 'function',
  function: {
    name: CANCEL_AGENT_TASK_TOOL_NAME,
    description: '取消用户此前交给后台、目前仍在排队或执行的工作。用户明确说取消、停止、别做了、不要继续，或要求取消“刚才那个任务”时必须调用，不要只口头说忽略结果。能够从运行上下文确定 work_id 时传入；用户泛指刚才的工作时可省略，系统会取消最近提交且仍活跃的工作。',
    parameters: {
      type: 'object',
      properties: {
        work_id: {
          type: 'string',
          description: '要取消的 work_id。仅在运行上下文已明确给出时填写；不得猜造。省略则取消当前语音会话最近提交且仍活跃的工作。',
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
    description: '查询此前交给后台工作的状态、进度或阶段性结果。用户询问“刚才那个怎么样了、还在做吗、做到哪一步、已经发现了什么、是否完成”时统一调用，不要自行判断普通任务或第三层任务，也不要改用 spawn_thinking。系统会直接回答普通任务，并自动查询第三层任务。能够从运行上下文确定 work_id 时传入；省略时查询当前语音会话最近的工作。',
    parameters: {
      type: 'object',
      properties: {
        work_id: {
          type: 'string',
          description: '要查询的 work_id。仅在运行上下文已明确给出时填写，不得猜造；省略时查询当前语音会话最近的工作。',
        },
        question: {
          type: 'string',
          description: '用户本轮对任务状态、进度或阶段结果的原始问题。尽量忠实保留，不要自行改写成另一项任务；省略时系统会使用本轮语音转写。',
        },
      },
      additionalProperties: false,
    },
  },
}

const getCurrentTimeTool = {
  type: 'function',
  function: {
    name: GET_CURRENT_TIME_TOOL_NAME,
    description: '获取用户本地时区中的准确当前日期、时间和星期。用户询问当前时间、今天日期、星期或相对日期判断时调用；不用于创建提醒。',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
}

const userMemoryTool = {
  type: 'function',
  function: {
    name: USER_MEMORY_TOOL_NAME,
    description: '管理千问Audio前台持有的用户记忆。profile 用于称呼、时区、语言和稳定交互偏好；long_term 用于用户明确希望跨会话保留的个人事实、喜好、目标和约定；不要保存项目执行历史或后台工作细节。使用 recall 回忆，remember 新增，replace 用新事实替换明确相关的旧记录，forget 遗忘。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['recall', 'remember', 'replace', 'forget'],
          description: '要执行的记忆操作。',
        },
        scope: {
          type: 'string',
          enum: ['profile', 'long_term', 'all'],
          description: '记忆范围。remember 和 replace 必须使用 profile 或 long_term；recall 和 forget 可以使用 all。',
        },
        content: {
          type: 'string',
          description: 'remember 或 replace 时要保存的完整、简洁事实。',
        },
        query: {
          type: 'string',
          description: 'recall 或 forget 时用于匹配记忆的自然语言查询。',
        },
        memory_ids: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 20,
          description: 'replace 时要被新事实取代的旧记忆 ID；必须来自本轮 recall 结果，不得猜造。',
        },
        all: {
          type: 'boolean',
          description: '仅用于 forget；用户明确要求清空所选范围时设为 true。',
        },
      },
      required: ['action', 'scope'],
      additionalProperties: false,
    },
  },
}

const respondAgentPermissionTool = {
  type: 'function',
  function: {
    name: RESPOND_AGENT_PERMISSION_TOOL_NAME,
    description: '回复当前正在等待用户决定的后台权限请求。由你结合刚提出的具体权限问题和用户本轮自然表达，智能判断为本会话自动允许、拒绝或尚不明确；不要依赖固定关键词。用户回答“可以”“行”“好”“允许”“同意”“没问题”等自然肯定表达就是明确同意，应调用 always，不得要求复述固定口令。明确拒绝时调用 reject，不明确时不要调用并继续询问。',
    parameters: {
      type: 'object',
      properties: {
        authorization_id: {
          type: 'string',
          description: '待确认请求的 authorization_id，必须来自当前运行上下文，不得猜造。',
        },
        decision: {
          type: 'string',
          enum: ['always', 'reject'],
          description: 'always 表示允许当前操作，并由 Gateway 在本次前台会话中自动允许后续权限请求；reject 表示拒绝当前操作，后续请求仍继续询问。',
        },
      },
      required: ['authorization_id', 'decision'],
      additionalProperties: false,
    },
  },
}

export const TOOLS = [
  delegateTool,
  cancelAgentTaskTool,
  getAgentTaskStatusTool,
  getCurrentTimeTool,
  userMemoryTool,
  respondAgentPermissionTool,
]

export const resultResponseInstructions = [
  '这是先前提交工作的最终结果，不是用户的新请求。',
  '把 result 当作事实材料，结合当前对话自然回应；可以按语境概括、合并、承接或询问必要信息，避免重复已经表达过的内容。',
  '输入包含多个 event 时，必须覆盖每个 event 的实质结果；不得只说其中一个，也不得让过程性或状态性内容掩盖真正完成的工作。',
  '开头直接说实际结果、关键发现、阻塞或必要问题，不用“好的、收到、任务完成了”等空泛承接语。',
  '不要朗读协议前缀、字段、执行 ID、路径、URL 或不适合口语的长内容。',
  '不要调用工具，不要添加事件中没有的事实，也不要把未完成说成完成。',
].join(' ')

export function speakResponseInstructions(content) {
  return `请以自然口语传达下面的信息，保持事实一致，不调用工具：\n${content}`
}

export const permissionResponseInstructions = [
  '这是后台 Agent 的权限请求。',
  '自然、简短地说明操作，并询问用户是否同意授权。',
  '不要规定具体回答方式，也不要提供或要求复述固定口令。',
  '不要调用工具或朗读内部字段，等待用户回答。',
].join(' ')

export function buildFrontendInstructions(agentContext = {}) {
  return `${loadFrontendPrompt()}\n\n${buildFrontendContext(agentContext)}`
}
