// 客服场景的结果播报适配器。
//
// 执行回执是客服 Agent 的业务协议，不是 Gateway 的通用 Task 协议；因此在
// 这里读取并投影，而不让通用 AnnouncementManager 认识客服 artifact/schema。
import {
  AnnouncementManager,
} from '../../../server/src/voice/announcement/announcement-manager.mjs'
import {
  ProgressAnnouncementManager,
} from '../../../server/src/voice/announcement/progress-announcement-manager.mjs'

export const EXECUTION_RECEIPT_SCHEMA =
  'qwen-audio-agent/customer-service-execution-receipt@1'

export function executionReceiptFromArtifacts(artifacts = []) {
  for (const artifact of artifacts) {
    if (artifact?.artifactId !== 'customer-service-execution-receipt') continue
    for (const part of artifact.parts || []) {
      if (part?.data?.schema === EXECUTION_RECEIPT_SCHEMA) return part.data
    }
  }
  return null
}

function mustUseReceiptOnly(receipt) {
  return Boolean(receipt && (
    Number(receipt.committedCount) > 0
    || ['partial', 'failed', 'cancelled', 'declined'].includes(receipt.outcome)
  ))
}

function receiptPresentation(receipt) {
  return [
    '<customer_service_execution_receipt>',
    'source=runtime_verified',
    `receipt=${JSON.stringify(receipt)}`,
    '请仅根据此回执自然告知客户：只有 committedOperations 中列出的操作可以说已经完成。',
    'no_change、declined、cancelled、failed、partial 都不能说成全部完成。',
    '状态、金额、编号、时效和连带影响只可使用 committedOperations 的 result/summary 明确事实；不要补充通知、费用、权益或截止时间。',
    'initiated、pending、processing、已发起、处理中或待入账不等于到账、已结清或已入账；只有回执给出等价终态才能这样说。',
    '</customer_service_execution_receipt>',
  ].join('\n')
}

function projectTask(task, field) {
  const receipt = executionReceiptFromArtifacts(task.artifacts)
  if (!mustUseReceiptOnly(receipt)) return task
  return {
    ...task,
    // 后台模型生成的 result/error 与原始 objective 都不再作为客户事实。
    objective: '',
    [field]: receiptPresentation(receipt),
  }
}

export class CustomerServiceAnnouncementManager extends AnnouncementManager {
  completed(task) {
    super.completed(projectTask(task, 'result'))
  }

  failed(task) {
    super.failed(projectTask(task, 'error'))
  }
}

export function createCustomerServiceTaskAnnouncementRuntime({
  resultOptions,
  progressOptions,
} = {}) {
  return {
    results: new CustomerServiceAnnouncementManager(resultOptions || {}),
    progress: new ProgressAnnouncementManager(progressOptions),
  }
}
