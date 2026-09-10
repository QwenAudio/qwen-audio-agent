import { MEMORY_DOCUMENTS, canonicalScope, isMemoryDocument } from './scopes.mjs'
import { toolFailure } from '../frontend/tools/tool-result.mjs'

export const MEMORY_TOOL_NAME = 'memory'
const SENSITIVE_MEMORY = /(?:pass(?:word)?|secret|api[_ -]?key|access[_ -]?token|credential|验证码|密码|密钥|令牌|\bsk-[a-z0-9_-]+)/i

const MEMORY_TOOL_DESCRIPTION = [
  '读取或编辑当前用户的长期个性化偏好与稳定事实；不是对话历史、工作进度、命名清单或知识库文档查询。',
  '不确定要修改的旧内容时先读取，再使用精确原文修改。',
  '不要保存密码、密钥、验证码、令牌、支付信息、证件号或敏感精确地址。',
].join('')

const memoryTool = {
  type: 'function',
  function: {
    name: MEMORY_TOOL_NAME,
    description: MEMORY_TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['read', 'append', 'replace'],
          description: 'read 读取已有内容；append 新增一项；replace 使用精确原文修改或删除一项。',
        },
        document: {
          type: 'string',
          enum: [...MEMORY_DOCUMENTS, 'all'],
          description: 'user 保存称呼、关系、助手名称、表达方式和默认做法等交互偏好；memory 保存用于理解用户的长期事实、兴趣和目标。read 可指定 all；append 和 replace 必须指定 user 或 memory。',
        },
        old_text: { type: 'string', description: 'replace 时使用：在已提供或 read 返回的相应上下文中恰好出现一次的原文。' },
        new_text: { type: 'string', description: 'replace 时使用：替换后的内容；空字符串表示删除。' },
        content: { type: 'string', description: 'append 时追加的简洁、可读 Markdown 内容。' },
        query: { type: 'string', description: 'read 时可选：要从长期记忆中查找的简洁自然语言问题。' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
}

export const memoryToolEntries = [{
  definition: memoryTool,
  policy: { requiredCapabilities: ['memory'] },
}]

async function executeMemoryToolCall(runtime, {
  callId,
  turnId,
  generation,
  args,
  event,
  callContext,
}) {
  const responseId = callContext.responseId || event.response_id || ''
  const deferred = runtime.beginDeferredToolResponse(responseId, {
    turnId,
    turnGeneration: generation,
  })
  try {
    await memory(runtime, callId, turnId, args, deferred
      ? { createResponse: false }
      : undefined)
  } catch (error) {
    await runtime.completeDeferredToolResponse(deferred, { failed: true })
    throw error
  }
  await runtime.completeDeferredToolResponse(deferred)
}

function notifyMemoryChanged(runtime) {
  try {
    runtime.onMemoryChanged()
  } catch {
    // Persistence succeeded even if a live prompt refresh did not.
  }
}

async function memory(runtime, callId, turnId, args, responseOptions) {
  const action = String(args.action || '').trim().toLowerCase()
  const document = canonicalScope(String(args.document || (action === 'read' ? 'all' : '')))
  const oldText = String(args.old_text || '')
  const newText = String(args.new_text || '')
  const hasNewText = Object.prototype.hasOwnProperty.call(args, 'new_text')
  const content = String(args.content || '').trim()
  const query = String(args.query || '').trim()
  const proposedContent = action === 'append' ? content : newText
  let output
  if (!runtime.memoryService) {
    output = toolFailure('memory_unavailable', '前台记忆功能当前不可用。')
  } else if (!['read', 'append', 'replace'].includes(action)) {
    output = toolFailure('invalid_memory_action', '没有识别出要执行的记忆操作。')
  } else if (action === 'read') {
    const scope = document === 'all' ? null : document
    if (scope && !isMemoryDocument(scope)) {
      await runtime.sendOutput(callId, toolFailure(
        'invalid_memory_document',
        '没有识别出要读取的记忆文档。',
      ), turnId, null, responseOptions)
      return
    }
    try {
      const result = query && typeof runtime.memoryService.query === 'function'
        ? await runtime.memoryService.query(runtime.ownerId, query, {
            ...(scope ? { scope } : {}),
            limit: 8,
          }, {
            source: 'realtime-tool',
            sessionId: runtime.sessionId,
            turnId,
            traceId: callId,
          })
        : {
            memories: scope
              ? runtime.memoryService.list(runtime.ownerId, { scope })
              : runtime.memoryService.list(runtime.ownerId),
            context: '',
          }
      const memories = result.memories
      output = {
        status: memories.length || result.context ? 'ok' : 'not_found',
        count: memories.length,
        documents: memories,
        ...(result.context ? { context: result.context } : {}),
      }
    } catch {
      output = toolFailure(
        'memory_read_failed',
        '暂时无法读取记忆，请稍后再试。',
        { retryable: true },
      )
    }
  } else if (!isMemoryDocument(document)) {
    output = toolFailure('invalid_memory_document', '写入记忆时必须指定 user 或 memory。')
  } else if (action === 'append' && !content) {
    output = toolFailure('invalid_memory_edit', 'append 需要明确的 content。')
  } else if (action === 'replace' && (!oldText || !hasNewText)) {
    output = toolFailure('invalid_memory_edit', 'replace 需要精确 old_text 和明确的 new_text。')
  } else if (SENSITIVE_MEMORY.test(proposedContent)) {
    output = toolFailure(
      'sensitive_memory',
      '为了安全，不会保存密码、密钥、验证码或令牌。',
      { status: 'rejected' },
    )
  } else {
    try {
      const change = {
        document,
        edits: action === 'replace' ? [{ old_text: oldText, new_text: newText }] : [],
        append: action === 'append' ? content : '',
      }
      const result = await runtime.memoryService.apply(runtime.ownerId, [change], {
        source: 'realtime-tool',
        sessionId: runtime.sessionId,
        turnId,
        traceId: callId,
      })
      if (result.changed) notifyMemoryChanged(runtime)
      output = {
        status: result.changed ? 'updated' : 'unchanged',
        changed: result.changed,
        documents: result.documents,
      }
    } catch (error) {
      if (['stale_document', 'edit_not_found', 'ambiguous_edit'].includes(error.code)) {
        output = toolFailure(
          error.code,
          '记忆文档已经变化或原文没有精确匹配，请重新读取后再修改。',
          {
            retryable: true,
            documents: runtime.memoryService.list(runtime.ownerId),
          },
        )
      } else {
        output = toolFailure(
          'memory_write_failed',
          '暂时无法修改记忆，请稍后再试。',
          { retryable: true },
        )
      }
    }
  }
  await runtime.sendOutput(callId, output, turnId, null, responseOptions)
}

export function memoryToolHandlers(runtime) {
  return { [MEMORY_TOOL_NAME]: context => executeMemoryToolCall(runtime, context) }
}
