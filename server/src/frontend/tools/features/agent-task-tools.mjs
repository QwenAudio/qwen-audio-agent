import { PERMISSION_DECISIONS } from '../../../../../shared/permission-decisions.mjs'
import {
  spawnThinkingTool,
} from '../spawn-thinking-tool.mjs'

export { SPAWN_THINKING_TOOL_NAME } from '../spawn-thinking-tool.mjs'
export const CANCEL_AGENT_TASK_TOOL_NAME = 'cancel_agent_task'
export const UPDATE_AGENT_TASK_TOOL_NAME = 'update_agent_task'
export const GET_AGENT_TASK_STATUS_TOOL_NAME = 'get_agent_task_status'
export const RESPOND_PERMISSION_TOOL_NAME = 'respond_permission'
export const PERMISSION_RESPONSE_CAPABILITY = 'permission.respond'

const cancelAgentTaskTool = {
  type: 'function',
  function: {
    name: CANCEL_AGENT_TASK_TOOL_NAME,
    description: '取消用户此前开始、目前仍可取消的异步工作、定时任务或提醒，支持取消一项、整组循环提醒或当前会话全部工作。',
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

const updateAgentTaskTool = {
  type: 'function',
  function: {
    name: UPDATE_AGENT_TASK_TOOL_NAME,
    description: '向已有工作补充要求、修改目标或回答追问，也可对已完成成果执行后续操作，保留原工作的关联上下文。',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '系统提供的目标工作 ID；指代不明确时先查询或询问，不得猜造。' },
        instruction: { type: 'string', description: '用户本次补充、修改的要求或对追问的回答。' },
        input_request_id: { type: 'string', description: '回答后台追问时原样使用请求中的 ID，防止回答过期问题；普通工作调整必须省略此字段，不要传 null。' },
        values: { type: 'object', description: '仅在回答后台追问的表单时填写对象，字段必须来自请求提供的 schema；普通工作调整或无需表单回答时必须省略此字段，不要传 null。', additionalProperties: true },
        input_refs: spawnThinkingTool.function.parameters.properties.input_refs,
      },
      required: ['task_id', 'instruction'],
      additionalProperties: false,
    },
  },
}

const getAgentTaskStatusTool = {
  type: 'function',
  function: {
    name: GET_AGENT_TASK_STATUS_TOOL_NAME,
    description: '查询已创建工作、定时任务或提醒的最新状态和结果，或列出近期记录以确定目标；不用于回顾聊天内容。',
    parameters: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: '系统返回的工作 ID，可来自当前对话或工具结果。不得猜造；省略时优先查询当前语音会话最近仍在进行的工作，没有时查询最近一项。',
        },
        list_all: {
          type: 'boolean',
          description: '列出当前用户最近的至多 20 项记录，包含其他会话中的工作、定时任务和提醒。需要列表或确定目标时设为 true；此时不填写 task_id。',
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
    description: '回复当前正在等待用户决定的权限请求。结合刚提出的具体操作和用户本轮自然表达判断；意思不明确时先询问。不得猜测权限来源、代替用户决定或要求固定口令。',
    parameters: {
      type: 'object',
      properties: {
        permission_id: {
          type: 'string',
          description: '只有一个待确认请求时可省略；有多个时，原样使用 Gateway 提供的 permission_id，不得猜造。',
        },
        decision: {
          type: 'string',
          enum: PERMISSION_DECISIONS,
          description: 'task：允许当前任务及其后续操作，用于普通肯定表达；always：本会话所有任务的后续权限请求自动允许，仅在用户明确要求时选择；reject：拒绝当前操作。',
        },
      },
      required: ['decision'],
      additionalProperties: false,
    },
  },
}

export const agentTaskToolEntries = [
  {
    definition: spawnThinkingTool,
    policy: { repeatHandling: 'handler' },
  },
  { definition: cancelAgentTaskTool },
  { definition: updateAgentTaskTool, policy: { repeatHandling: 'handler' } },
  { definition: getAgentTaskStatusTool },
  {
    definition: respondPermissionTool,
    policy: {
      requiredCapabilities: [PERMISSION_RESPONSE_CAPABILITY],
    },
  },
]

export function agentTaskToolHandlers(runtime) {
  return {
    spawn_thinking: context => runtime.executeSpawnThinkingToolCall(context),
    [UPDATE_AGENT_TASK_TOOL_NAME]: context => runtime.executeUpdateToolCall(context),
    [CANCEL_AGENT_TASK_TOOL_NAME]: context => runtime.executeCancelToolCall(context),
    [GET_AGENT_TASK_STATUS_TOOL_NAME]: context => runtime.executeStatusToolCall(context),
    [RESPOND_PERMISSION_TOOL_NAME]: context => runtime.respondPermission(context),
  }
}
