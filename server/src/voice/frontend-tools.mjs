import {
  buildFrontendContext,
  loadFrontendPrompt,
  resolveAssistantProfile,
} from '../conversation/frontend-agent-context.mjs'
import { FrontendToolRegistry } from './tools/frontend-tool-registry.mjs'
import {
  spawnThinkingTool,
  withSpawnThinkingDescription,
} from './tools/spawn-thinking-tool.mjs'
import {
  agentTaskToolEntries,
  BACKEND_INPUT_RESPONSE_CAPABILITY,
  CANCEL_AGENT_TASK_TOOL_NAME,
  GET_AGENT_TASK_STATUS_TOOL_NAME,
  PERMISSION_RESPONSE_CAPABILITY,
  RESPOND_AGENT_INPUT_TOOL_NAME,
  RESPOND_PERMISSION_TOOL_NAME,
  SPAWN_THINKING_TOOL_NAME,
} from './tools/features/agent-task-tools.mjs'
import {
  clientToolEntries,
  ENTER_SLEEP_TOOL_NAME,
} from './tools/features/client-tools.mjs'
import {
  coreToolEntries,
  GET_CURRENT_TIME_TOOL_NAME,
} from './tools/features/core-tools.mjs'
import {
  MEMORY_TOOL_NAME,
  NOTES_TOOL_NAME,
  personalToolEntries,
} from './tools/features/personal-tools.mjs'
import {
  FETCH_URL_TOOL_NAME,
  FRONTEND_RECALL_CAPABILITY,
  KNOWLEDGE_TOOL_NAME,
  RECALL_TOOL_NAME,
  retrievalToolEntries,
  WEB_SEARCH_TOOL_NAME,
} from './tools/features/retrieval-tools.mjs'
import {
  scheduleToolEntries,
  scheduleToolForContext,
  SCHEDULE_REMINDER_TOOL_NAME,
} from './tools/features/schedule-tools.mjs'

export {
  BACKEND_INPUT_RESPONSE_CAPABILITY,
  CANCEL_AGENT_TASK_TOOL_NAME,
  ENTER_SLEEP_TOOL_NAME,
  FETCH_URL_TOOL_NAME,
  FRONTEND_RECALL_CAPABILITY,
  GET_AGENT_TASK_STATUS_TOOL_NAME,
  GET_CURRENT_TIME_TOOL_NAME,
  KNOWLEDGE_TOOL_NAME,
  MEMORY_TOOL_NAME,
  NOTES_TOOL_NAME,
  PERMISSION_RESPONSE_CAPABILITY,
  RECALL_TOOL_NAME,
  RESPOND_AGENT_INPUT_TOOL_NAME,
  RESPOND_PERMISSION_TOOL_NAME,
  SCHEDULE_REMINDER_TOOL_NAME,
  SPAWN_THINKING_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
}

const featureEntries = [
  ...agentTaskToolEntries,
  ...scheduleToolEntries,
  ...coreToolEntries,
  ...personalToolEntries,
  ...retrievalToolEntries,
  ...clientToolEntries,
]
const entriesByName = new Map(featureEntries.map(entry => [
  entry.definition.function.name,
  entry,
]))
const toolOrder = [
  SPAWN_THINKING_TOOL_NAME,
  SCHEDULE_REMINDER_TOOL_NAME,
  CANCEL_AGENT_TASK_TOOL_NAME,
  GET_AGENT_TASK_STATUS_TOOL_NAME,
  GET_CURRENT_TIME_TOOL_NAME,
  MEMORY_TOOL_NAME,
  NOTES_TOOL_NAME,
  KNOWLEDGE_TOOL_NAME,
  RECALL_TOOL_NAME,
  RESPOND_PERMISSION_TOOL_NAME,
  RESPOND_AGENT_INPUT_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  FETCH_URL_TOOL_NAME,
  ENTER_SLEEP_TOOL_NAME,
]

export const frontendToolRegistry = new FrontendToolRegistry(
  toolOrder.map(name => entriesByName.get(name)),
)

export const TOOLS = frontendToolRegistry.definitions()

function dynamicFrontendTools(agentContext = {}) {
  const configured = agentContext?.frontend?.tools
  if (!Array.isArray(configured)) return []
  const names = new Set(frontendToolRegistry.names())
  return configured.map(tool => {
    const name = String(tool?.function?.name || '').trim()
    if (!name || names.has(name)) {
      throw new Error(`Invalid or duplicate dynamic frontend tool: ${name || '(unnamed)'}`)
    }
    names.add(name)
    return tool
  })
}

export function frontendTools(agentContext = {}) {
  const spawnThinkingDescription = agentContext?.frontend?.spawnThinkingDescription
  const tools = frontendToolRegistry.definitions(agentContext).map(tool => {
    if (tool === spawnThinkingTool && spawnThinkingDescription) {
      return withSpawnThinkingDescription(spawnThinkingDescription)
    }
    if (tool.function.name === SCHEDULE_REMINDER_TOOL_NAME) {
      return scheduleToolForContext(agentContext)
    }
    return tool
  })
  const dynamic = dynamicFrontendTools(agentContext)
  if (dynamic.length) return [...tools, ...dynamic]
  return tools.length === TOOLS.length
    && tools.every((tool, index) => tool === TOOLS[index])
    ? TOOLS
    : tools
}

export const resultResponseInstructions = [
  '这是先前提交工作的最终结果，不是用户的新请求。',
  '把 result 当作事实材料，结合当前对话自然回应；可以按语境概括、合并、承接或询问必要信息，避免重复已经表达过的内容。',
  '结果上下文包含多项工作时，必须覆盖每项工作的实质结果；不得只说其中一项，也不得让过程性或状态性内容掩盖真正完成的工作。',
  '结果若提出继续工作所需的问题、选择、确认或补充信息，只自然转达该需要；用户后续回答会作为同一工作的续办处理。',
  '开头直接说实际结果、关键发现、阻塞或必要问题，不用“好的、收到、任务完成了”等空泛承接语。',
  '屏幕上已经展示详细结果时，只说重点和查看方向，不要逐字朗读。',
  '不要朗读协议前缀、字段、执行 ID、路径、URL 或不适合口语的长内容。',
  '不要调用工具，不要添加事件中没有的事实，也不要把未完成说成完成。',
].join(' ')

export const progressResponseInstructions = [
  '这是先前提交工作的一条阶段性更新，不是最终结果，也不是用户的新请求。',
  '只用一句自然口语简短转达当前进展；不要展开推理过程，也不要把未完成说成完成。',
  '不要朗读协议标签、内部字段、执行 ID、路径、URL 或不适合口语的长内容。',
  '不要调用工具，不要添加更新中没有的事实。',
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

export const inputRequestResponseInstructions = [
  '这是同一项后台工作为继续执行而提出的补充问题，不是最终结果，也不是新任务。',
  '自然、简短地转达问题并等待用户回答；不要调用 spawn_thinking。',
  '用户回答后调用 respond_agent_input，把回答交回同一项工作。',
  '不要朗读协议字段或工作 ID，也不要把等待输入说成工作已经完成。',
].join(' ')

export function buildFrontendInstructions(agentContext = {}) {
  return [
    loadFrontendPrompt(),
    '# Assistant Profile',
    '<assistant_profile authority="persona_only">',
    resolveAssistantProfile(agentContext),
    '</assistant_profile>',
    buildFrontendContext(agentContext),
  ].join('\n\n')
}
