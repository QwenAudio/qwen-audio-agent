import OpenAI from 'openai'
import { config } from 'dotenv'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { tools, executors } from './tools/index.mjs'
import { builtinDomainCatalog, builtinSkillCatalog } from './skills/builtin/index.mjs'
import { getMemoryForPrompt } from './memory.mjs'
import { loadHistory, appendToHistory, buildMessages, compactHistory } from './context.mjs'
import { loadCustomSkillCatalog } from './tools/skill-manage.mjs'
import { getSoulPrompt } from './souls.mjs'
import { buildCurrentTimePrompt } from './time-context.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
config({ path: resolve(__dirname, '../.env.local') })

const client = new OpenAI({
  apiKey: process.env.DASHSCOPE_API_KEY,
  baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
})
const model = process.env.DASHSCOPE_MODEL || 'qwen3.6-plus'

const MAX_ROUNDS = 12
const DEFAULT_AGENT_TOTAL_TIMEOUT_MS = 45000
const DEFAULT_LLM_TIMEOUT_MS = 22000
const DEFAULT_TOOL_TIMEOUT_MS = 15000

function timeoutError(label, timeoutMs) {
  const err = new Error(`${label}超时（${Math.round(timeoutMs / 1000)}秒）`)
  err.code = 'ETIMEDOUT'
  return err
}

function remainingTimeout(deadline, limitMs) {
  return Math.max(1, Math.min(limitMs, deadline - Date.now()))
}

function assertNotTimedOut(deadline, label = '服务端 LLM') {
  if (Date.now() >= deadline) throw timeoutError(label, 0)
}

function withTimeout(promise, timeoutMs, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(timeoutError(label, timeoutMs)), timeoutMs)
    }),
  ]).finally(() => clearTimeout(timer))
}

function agentTimeoutOptions(options = {}) {
  return {
    totalTimeoutMs: options.totalTimeoutMs ?? DEFAULT_AGENT_TOTAL_TIMEOUT_MS,
    llmTimeoutMs: options.llmTimeoutMs ?? DEFAULT_LLM_TIMEOUT_MS,
    toolTimeoutMs: options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
  }
}

function toolChoiceFor(skillName) {
  if (!skillName || !executors[skillName]) return undefined
  return { type: 'function', function: { name: skillName } }
}

function normalizeTriggerText(value) {
  return String(value || '').replace(/\s+/g, '').replace(/[，,。.!！？?：“”"'「」『』（）()【】[\]]/g, '').toLowerCase()
}

async function inferRequiredCustomSkillForMessage(userMessage, clientId) {
  const text = normalizeTriggerText(userMessage)
  if (!text) return null

  const customSkills = await loadCustomSkillCatalog(clientId)
  const matched = customSkills.some((skill) => {
    const name = normalizeTriggerText(skill.name)
    const description = normalizeTriggerText(skill.description)
    return (name && text.includes(name)) || (description && description.includes(text))
  })

  return matched ? 'skill_run' : null
}

function collectResultActions(result) {
  const actions = []
  if (Array.isArray(result?.actions)) actions.push(...result.actions)
  if (result?.action) actions.push(result.action)
  return actions
}

function compactJson(value, maxLength = 240) {
  const text = JSON.stringify(value ?? {})
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text
}

function resultContent(result) {
  return typeof result?.result === 'string' ? result.result : JSON.stringify(result?.result)
}

function compactResult(value, maxLength = 180) {
  const text = String(value || '')
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text
}

function formatActionTrace(actions = []) {
  if (!actions.length) return '无 UI action'
  return actions.map((action) => {
    if (action.type === 'car_control') return `car_control(${action.part}=${action.state})`
    if (action.type === 'music') return `music(${action.action}${action.query ? `:${action.query}` : ''})`
    if (action.type === 'navigation') return `navigation(${action.action}${action.destination ? `:${action.destination}` : ''})`
    if (action.type === 'flashbuy') return `flashbuy(${action.action}${action.status ? `:${action.status}` : ''})`
    return `${action.type || 'action'}`
  }).join(', ')
}

function buildToolHistoryMessage(toolRecords) {
  if (!toolRecords.length) return null
  const lines = toolRecords.map((record, index) => (
    `${index + 1}. ${record.name}(${compactJson(record.arguments)}) => ${compactResult(record.result)}；actions: ${formatActionTrace(record.actions)}`
  ))
  return {
    role: 'system',
    content: `【工具执行记录】上一轮用户请求已通过真实 function call 完成。后续遇到同类车控、导航、音乐、闪购、天气、联网、记忆或提醒请求，仍必须调用对应 function，禁止只用文字声称已完成。\n${lines.join('\n')}`,
  }
}

function historyMessagesForTurn(userMessage, assistantContent, toolRecords = []) {
  const messages = [{ role: 'user', content: userMessage }]
  const toolHistory = buildToolHistoryMessage(toolRecords)
  if (toolHistory) messages.push(toolHistory)
  messages.push({ role: 'assistant', content: assistantContent })
  return messages
}

function buildDomainPromptSections() {
  const sections = builtinDomainCatalog
    .filter(domain => domain.routeRules?.length || domain.examples?.length)
    .map((domain) => {
      const lines = [`${domain.label}的唯一正确流程：`]
      for (const rule of domain.routeRules || []) {
        lines.push(`- ${rule}`)
      }
      if (domain.examples?.length) {
        lines.push('', '示例：')
        for (const example of domain.examples) {
          lines.push(`- ${example}`)
        }
      }
      return lines.join('\n')
    })

  return sections.join('\n\n')
}

function listDomainToolNames(domainName) {
  const domain = builtinDomainCatalog.find(item => item.domain === domainName)
  return domain?.functions?.map(fn => fn.name).join('、') || domainName
}

async function buildSystemPrompt(soul, clientId = 'default') {
  const memoryText = await getMemoryForPrompt(clientId)
  const customSkills = await loadCustomSkillCatalog(clientId)
  const soulPrompt = getSoulPrompt(soul)
  const currentTimePrompt = buildCurrentTimePrompt()
  const domainPromptSections = buildDomainPromptSections()
  const navigationTools = listDomainToolNames('navigation')
  const vehicleTools = listDomainToolNames('vehicle')
  const musicTools = listDomainToolNames('music')

  let prompt = `${soulPrompt}

${currentTimePrompt}

你能帮助用户控制车辆、导航、播放音乐、设置提醒等。

你的行为准则：
- 执行操作前确认关键参数，但不要过度确认简单请求
- 一次可以执行多个操作来完成复合任务
- 如果用户的请求需要多步操作，按顺序依次执行

## 最高优先级规则（必须严格遵守，违反即为严重错误）

你是一个执行者，不是描述者。所有操作必须通过调用工具完成，禁止用文字假装完成了操作。

你当前可以直接调用的“内置技能”（Built-in Skills）如下，领域函数定义以 domains/*.json 为准：
${builtinSkillCatalog.map((s) => {
  return `- ${s.toolName}（${s.name}）：${s.description}`
}).join('\n')}

${domainPromptSections}

【记忆规则】
- 当用户透露个人信息（姓名、昵称、喜好、习惯、职业等）时，必须调用 memory_write 工具记录
- 当用户表达偏好（喜欢/不喜欢某事物、希望如何称呼等）时，必须调用 memory_write 工具记录
- 当用户表达长期目标、梦想、愿望、理想或“想成为...”时，必须调用 memory_write 工具记录
- 当用户设定互动规则（如"当我说X你要回答Y"、"每次...你就..."）时，必须调用 memory_write 工具记录
- 任何用户希望你"记住"或"以后要"的内容，都必须调用 memory_write 工具，绝对不能仅口头回应
- 记忆内容要简洁明了，例如"用户名字叫张彬彬"、"用户说天王盖地虎时要回答小鸡炖蘑菇"
- 写入新记忆前，必须先调用 memory_read 检查是否已有相关记忆
- 如果第一轮已经调用了 memory_read，并且用户原话包含姓名、昵称、偏好、习惯、职业、住址、公司、梦想、目标、愿望、理想或希望你记住的规则，下一步必须调用 memory_write 或先 memory_delete 再 memory_write，禁止只口头说“已记住”
- 如果已有相关但过时的记忆，先用 memory_delete 删除旧记忆，再用 memory_write 写入新记忆
- memory_read 返回的每条记忆前有 [索引号]，将该索引号传给 memory_delete 即可删除

【技能创建规则】
- 当用户明确说"帮我创建一个技能"或类似表述时，调用 skill_create 创建自定义技能
- 当用户描述条件触发的任务（如"每天下班后帮我..."、"到家时自动..."、"每次...就..."），主动建议为其创建自定义技能，用户确认后调用 skill_create
- skill_id 使用简短的中文名称（如"下班回家"、"午睡模式"）
- instructions 中优先使用内置技能（车控：${vehicleTools}；导航：${navigationTools}；音乐：${musicTools}）编排执行步骤；只有时间、位置、记忆、提醒等基础能力才使用对应系统工具
- 当用户命中可用自定义技能的名称或描述里的触发条件时，必须先调用 skill_run 加载完整指令，再根据指令执行或回复，禁止只凭技能摘要直接回答

`
  if (memoryText) {
    prompt += memoryText + '\n\n'
  }

  if (customSkills.length > 0) {
    prompt += '【可用的自定义技能】（调用 skill_run 加载详情）\n'
    customSkills.forEach((s) => {
      prompt += `- ${s.name}: ${s.description}\n`
    })
    prompt += '\n'
  }

  return prompt
}

export async function chat(userMessage, sessionId = 'default', vehicleState = {}, soul = '聊愈师', strategy = 0, thinking = true, clientId = 'default', options = {}) {
  const startTime = Date.now()
  const timeouts = agentTimeoutOptions(options)
  const deadline = startTime + timeouts.totalTimeoutMs
  const history = await loadHistory(sessionId)
  const systemPrompt = await buildSystemPrompt(soul, clientId)

  const trimmedHistory = buildMessages(history)
  const messages = [
    { role: 'system', content: systemPrompt },
    ...trimmedHistory,
    { role: 'user', content: userMessage },
  ]

  const actions = []
  const toolRecords = []
  const requiredSkill = await inferRequiredCustomSkillForMessage(userMessage, clientId)
  const debug = {
    rounds: 0,
    model,
    duration_ms: 0,
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    tool_calls: [],
    thinking: '',
  }
  const context = {
    vehicleState,
    strategy,
    clientId,
    compactHistory: (keepLast) => compactHistory(sessionId, keepLast),
    onProgress: () => {},
  }

  for (let round = 0; round < MAX_ROUNDS; round++) {
    assertNotTimedOut(deadline)
    debug.rounds = round + 1

    const reqParams = {
      model,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      tool_choice: toolChoiceFor(round === 0 ? requiredSkill : null) || (tools.length > 0 ? 'auto' : undefined),
      enable_thinking: Boolean(thinking),
    }

    const llmTimeoutMs = remainingTimeout(deadline, timeouts.llmTimeoutMs)
    const completion = await client.chat.completions.create(reqParams, { timeout: llmTimeoutMs, maxRetries: 0 })

    if (completion.usage) {
      debug.usage.prompt_tokens += completion.usage.prompt_tokens || 0
      debug.usage.completion_tokens += completion.usage.completion_tokens || 0
      debug.usage.total_tokens += completion.usage.total_tokens || 0
    }

    const choice = completion.choices[0]
    const msg = choice.message

    if (msg.reasoning_content) {
      debug.thinking += msg.reasoning_content
    }

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      const content = msg.content || ''
      await appendToHistory(sessionId, ...historyMessagesForTurn(userMessage, content, toolRecords))
      debug.duration_ms = Date.now() - startTime
      return { content, actions, debug }
    }

    messages.push({
      role: 'assistant',
      content: msg.content || null,
      tool_calls: msg.tool_calls,
    })

    for (const toolCall of msg.tool_calls) {
      assertNotTimedOut(deadline, '工具执行')
      const fnName = toolCall.function.name
      const fnArgs = JSON.parse(toolCall.function.arguments || '{}')
      const executor = executors[fnName]

      const callStart = Date.now()
      let result
      if (executor) {
        try {
          result = await withTimeout(
            executor(fnArgs, context),
            remainingTimeout(deadline, timeouts.toolTimeoutMs),
            `工具 ${fnName}`,
          )
        } catch (err) {
          result = { result: `执行出错: ${err.message}` }
        }
      } else {
        result = { result: `未知工具: ${fnName}` }
      }
      const callDuration = Date.now() - callStart

      const resultText = resultContent(result)
      if (result.subCalls?.length) {
        for (const sub of result.subCalls) {
          debug.tool_calls.push({
            name: sub.name,
            arguments: sub.arguments,
            result: sub.result || '',
            duration_ms: sub.duration_ms,
          })
        }
      }

      debug.tool_calls.push({
        name: fnName,
        arguments: fnArgs,
        result: resultText,
        duration_ms: callDuration,
      })

      const resultActions = collectResultActions(result)
      actions.push(...resultActions)
      toolRecords.push({
        name: fnName,
        arguments: fnArgs,
        result: resultText,
        actions: resultActions,
      })

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: resultText,
      })
    }
  }

  await appendToHistory(
    sessionId,
    ...historyMessagesForTurn(userMessage, '调用次数过多，请重试', toolRecords),
  )
  debug.duration_ms = Date.now() - startTime
  return { content: '调用次数过多，请重试', actions, debug }
}

export async function chatStream(userMessage, sessionId = 'default', vehicleState = {}, soul = '聊愈师', strategy = 0, thinking = true, clientId = 'default', onEvent, options = {}) {
  const startTime = Date.now()
  const timeouts = agentTimeoutOptions(options)
  const deadline = startTime + timeouts.totalTimeoutMs
  let eventToken = 0
  const emit = (event, token = eventToken) => {
    if (token === eventToken && Date.now() < deadline) onEvent(event)
  }
  const history = await loadHistory(sessionId)
  const systemPrompt = await buildSystemPrompt(soul, clientId)

  const trimmedHistory = buildMessages(history)
  const messages = [
    { role: 'system', content: systemPrompt },
    ...trimmedHistory,
    { role: 'user', content: userMessage },
  ]

  const actions = []
  const toolRecords = []
  const requiredSkill = await inferRequiredCustomSkillForMessage(userMessage, clientId)
  const debug = {
    rounds: 0,
    model,
    duration_ms: 0,
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }
  const context = {
    vehicleState,
    strategy,
    clientId,
    compactHistory: (keepLast) => compactHistory(sessionId, keepLast),
    onSubCall: (info) => emit({ type: 'tool_call', ...info }),
    onMapEvent: (event) => emit({ type: 'map_action', ...event }),
    onProgress: (event) => emit({ type: 'progress', ...event }),
  }

  for (let round = 0; round < MAX_ROUNDS; round++) {
    assertNotTimedOut(deadline)
    debug.rounds = round + 1

    const streamParams = {
      model,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      tool_choice: toolChoiceFor(round === 0 ? requiredSkill : null) || (tools.length > 0 ? 'auto' : undefined),
      stream: true,
      stream_options: { include_usage: true },
      enable_thinking: Boolean(thinking),
    }

    const llmTimeoutMs = remainingTimeout(deadline, timeouts.llmTimeoutMs)
    const stream = await client.chat.completions.create(streamParams, { timeout: llmTimeoutMs, maxRetries: 0 })

    let contentBuf = ''
    const toolCallBufs = {}

    await withTimeout((async () => {
      for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta
      if (chunk.usage) {
        debug.usage.prompt_tokens += chunk.usage.prompt_tokens || 0
        debug.usage.completion_tokens += chunk.usage.completion_tokens || 0
        debug.usage.total_tokens += chunk.usage.total_tokens || 0
      }
      if (!delta) continue

      if (delta.reasoning_content) {
        emit({ type: 'thinking', content: delta.reasoning_content })
      }

      if (delta.content) {
        contentBuf += delta.content
        emit({ type: 'text', content: delta.content })
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index
          if (!toolCallBufs[idx]) {
            toolCallBufs[idx] = { id: tc.id || '', name: tc.function?.name || '', arguments: '' }
          }
          if (tc.id) toolCallBufs[idx].id = tc.id
          if (tc.function?.name) toolCallBufs[idx].name = tc.function.name
          if (tc.function?.arguments) toolCallBufs[idx].arguments += tc.function.arguments
        }
      }
      }
    })(), remainingTimeout(deadline, llmTimeoutMs), '服务端 LLM 流式响应')

    const toolCalls = Object.values(toolCallBufs)

    if (toolCalls.length === 0) {
      await appendToHistory(sessionId, ...historyMessagesForTurn(userMessage, contentBuf, toolRecords))
      debug.duration_ms = Date.now() - startTime
      emit({ type: 'done', content: contentBuf, actions, debug })
      return
    }

    messages.push({
      role: 'assistant',
      content: contentBuf || null,
      tool_calls: toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } })),
    })

    for (const tc of toolCalls) {
      assertNotTimedOut(deadline, '工具执行')
      const fnName = tc.name
      const fnArgs = JSON.parse(tc.arguments || '{}')
      const executor = executors[fnName]
      const toolToken = ++eventToken
      const toolContext = {
        ...context,
        onSubCall: (info) => emit({ type: 'tool_call', ...info }, toolToken),
        onMapEvent: (event) => emit({ type: 'map_action', ...event }, toolToken),
        onProgress: (event) => emit({ type: 'progress', ...event }, toolToken),
      }

      const callStart = Date.now()
      let result
      if (executor) {
        try {
          result = await withTimeout(
            executor(fnArgs, toolContext),
            remainingTimeout(deadline, timeouts.toolTimeoutMs),
            `工具 ${fnName}`,
          )
        } catch (err) {
          result = { result: `执行出错: ${err.message}` }
        }
      } else {
        result = { result: `未知工具: ${fnName}` }
      }
      eventToken += 1
      const callDuration = Date.now() - callStart
      const resultText = resultContent(result)

      emit({
        type: 'tool_call',
        name: fnName,
        arguments: fnArgs,
        result: resultText,
        duration_ms: callDuration,
      })

      const resultActions = collectResultActions(result)
      actions.push(...resultActions)
      toolRecords.push({
        name: fnName,
        arguments: fnArgs,
        result: resultText,
        actions: resultActions,
      })
      for (const action of resultActions) {
        emit({ type: 'action', action })
      }

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: resultText,
      })
    }
  }

  debug.duration_ms = Date.now() - startTime
  emit({ type: 'done', content: '调用次数过多，请重试', actions, debug })
}
