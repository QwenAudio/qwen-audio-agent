import { randomUUID } from 'node:crypto'
import { PERMISSION_DECISIONS } from '../../../shared/permission-decisions.mjs'
import { createAgentDelivery } from '../delivery/agent-delivery.mjs'
import {
  permissionResponseInstructions,
  inputRequestResponseInstructions,
} from '../frontend/frontend-tools.mjs'
import { resolveTaskAnnouncementRuntime } from './announcement/task-announcement-runtime.mjs'

function inputSchemaSummary(schema) {
  const properties = schema?.properties
  if (!properties || typeof properties !== 'object') return ''
  const required = new Set(Array.isArray(schema.required) ? schema.required : [])
  const fields = Object.entries(properties).slice(0, 32).map(([name, field]) => ({
    name: String(name).slice(0, 160),
    type: String(field?.type || 'string').slice(0, 40),
    required: required.has(name),
    ...(field?.title ? { title: String(field.title).slice(0, 200) } : {}),
    ...(Array.isArray(field?.enum)
      ? { options: field.enum.slice(0, 32).map(value => String(value).slice(0, 200)) }
      : {}),
  }))
  return fields.length ? JSON.stringify(fields) : ''
}

/** Realtime presentation adapter; no Task state, execution or transport ownership. */
export function createRealtimeTaskPresentation({
  getState, getFrontend, deliveryRuntime, updateContext, cancelPermission,
  taskAnnouncementFactory, config, onError, onProgressError,
}) {
  return {
    state: getState,
    updateContext,
    createAnnouncements({ isTaskActive, onDelivered, onLeaseRenew, onRelease }) {
      return resolveTaskAnnouncementRuntime(taskAnnouncementFactory, {
        resultOptions: {
          getFrontend,
          deliveryRuntime,
          isDeliveryBlocked: () => {
            const state = getState()
            return state.sleeping || state.waking || !state.outputEnabled || state.windowBlocked
          },
          announceIntoContext: config.announceIntoContext,
          resultContextMaxChars: config.resultContextMaxChars,
          maxBatchItems: config.announcementMaxBatchItems,
          batchWindowMs: config.announcementBatchMs,
          acknowledgementTimeoutMs: config.announcementAcknowledgementTimeoutMs,
          maxRetryAttempts: config.announcementMaxRetryAttempts,
          leaseRenewIntervalMs: Math.max(1000, Math.floor(config.taskNotificationClaimTtlMs / 3)),
          onDelivered,
          onLeaseRenew,
          onRelease,
          onError: error => onError(`后台结果暂时无法播报，正在自动重试：${error.message}`),
        },
        progressOptions: {
          getFrontend,
          deliveryRuntime,
          isDeliveryBlocked: () => {
            const state = getState()
            return state.sleeping || state.waking || !state.outputEnabled || !state.ready || state.busy
          },
          isTaskActive,
          intervalMs: 60_000,
          quietMs: config.announcementQuietMs,
          onError: onProgressError,
        },
      })
    },
    presentRequest(kind, task, options) {
      const permission = kind === 'permission'
      const request = permission ? task.authorization : task.inputRequest
      const fields = permission ? '' : inputSchemaSummary(request.schema)
      return deliveryRuntime.deliver(createAgentDelivery({
        id: `${permission ? 'permission' : 'input'}_${request.id}`,
        causeEventId: request.id,
        mode: 'respond',
        origin: permission ? 'permission' : 'backend-input',
        text: (permission ? [
          '<permission_request>',
          `permission_id=${request.id}`,
          `task_id=${task.id}`,
          `operation=${request.summary}`,
          `allowed_decisions=${PERMISSION_DECISIONS.join(',')}`,
          '</permission_request>',
        ] : [
          '<backend_input_request>',
          `task_id=${task.id}`,
          `request=${request.prompt}`,
          ...(fields ? [`fields=${fields}`] : []),
          ...(request.mode === 'url' && request.url ? [`url=${request.url}`] : []),
          '</backend_input_request>',
        ]).join('\n'),
        correlation: {
          turnId: `gateway_${randomUUID().replaceAll('-', '')}`,
          taskId: task.id,
          ...(permission ? { authorizationId: request.id } : { inputRequestId: request.id }),
        },
        presentation: {
          instructions: permission ? permissionResponseInstructions : inputRequestResponseInstructions,
          contextTiming: 'immediate',
        },
      }), options)
    },
    resolveRequest(kind, id, { announced }) {
      const frontend = getFrontend()
      if (kind === 'permission') {
        if (announced && getState().ready) {
          frontend.appendUserInputContext([{
            type: 'text',
            text: '（系统提示：刚才的后台权限请求已处理完毕，任务继续执行；'
              + '无需再询问或回应该请求。）',
          }]).catch(() => {})
        }
        frontend?.cancelResponses((context, origin) => (
          origin === 'permission' && context?.authorizationId === id
        ))
        cancelPermission(id)
      } else {
        frontend?.cancelResponses((context, origin) => (
          origin === 'backend-input' && context?.inputRequestId === id
        ))
      }
    },
    reportRequestError(kind, error) {
      onError(kind === 'permission'
        ? `暂时无法询问权限：${error.message}`
        : `暂时无法转达后台问题：${error.message}`)
    },
  }
}
