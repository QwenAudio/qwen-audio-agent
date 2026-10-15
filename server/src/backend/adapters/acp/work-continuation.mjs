import { appendPromptBlocks } from './content.mjs'
import { updateError } from './turn-updates.mjs'

// Adapter-private, durable routing. An empty project list means direct work;
// missing routing (older tokens) must never be mistaken for direct work.
const VERSION = 1

export function readWorkContinuation(context, protocol) {
  if (context == null) return null
  if (context.adapter !== protocol || context.version !== VERSION
    || typeof context.token !== 'string' || !context.token.trim()
    || !Array.isArray(context.projects)
    || context.projects.some(target => !target || typeof target.sessionId !== 'string'
      || !target.sessionId.trim() || typeof target.directory !== 'string' || !target.directory.trim())) {
    throw updateError('context_unavailable', '原后台续接信息不完整或不兼容，不能自动重做。')
  }
  return context
}

export function projectTargets(run) {
  const targets = new Map()
  for (const target of [...(run.projectTargets || []), ...(run.delegations || [])]) {
    targets.set(target.sessionId, {
      sessionId: target.sessionId, directory: target.directory, title: target.title,
    })
  }
  return [...targets.values()]
}

export function workContinuation(protocol, sessionId, run) {
  // Native internal delegates without session_send/turnUpdates are observable,
  // but that alone does not make their execution contexts safely resumable.
  if (run.delegations.some(target => !target.turnUpdates)) return null
  return { adapter: protocol, version: VERSION, token: sessionId, projects: projectTargets(run) }
}

export function projectUpdatePrompt(targets, prompt) {
  return appendPromptBlocks([
    '用户补充了以下要求。将它发送到本请求中对应的已有项目 Session，不要创建新工作：',
    ...targets.map(target => `${target.sessionId}: ${target.title || target.sessionId}`),
  ].join('\n'), typeof prompt === 'string' ? [{ type: 'text', text: prompt }] : prompt)
}

export function assertProjectUpdateDelivered(run) {
  if (!run.updatedTargets) {
    throw updateError('update_not_delivered', '协调 Agent 未将补充要求送达目标工作。')
  }
}
