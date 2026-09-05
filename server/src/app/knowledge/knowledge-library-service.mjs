import { basename } from 'node:path'
import { TaskNotificationPolicy } from '../../task/task-state.mjs'
import {
  assertKnowledgeProvider,
  supportsKnowledgeManagement,
} from '../../frontend/knowledge/retrieval-provider.mjs'

function clean(value) {
  return String(value || '').trim()
}

/**
 * Client-facing document management over the same provider used for
 * retrieval. TaskManager supplies generic queuing/cancellation only. Provider
 * and backend Session details stay internal, and ingestion completion is silent.
 */
export class KnowledgeLibraryService {
  constructor({ provider, taskManager } = {}) {
    this.provider = assertKnowledgeProvider(provider)
    if (!supportsKnowledgeManagement(provider)) {
      throw new TypeError('KnowledgeLibraryService requires ingest/list/remove')
    }
    if (!taskManager || typeof taskManager.create !== 'function') {
      throw new TypeError('KnowledgeLibraryService requires a task manager')
    }
    this.taskManager = taskManager
  }

  startIngestion({ ownerId, sourcePath } = {}) {
    const owner = clean(ownerId)
    const path = clean(sourcePath)
    if (!owner || !path) {
      throw new TypeError('Knowledge ingestion requires ownerId and sourcePath')
    }
    const name = basename(path) || path
    const task = this.taskManager.create({
      objective: `导入资料：${name}`,
      ownerId: owner,
      kind: 'knowledge_ingestion',
      notificationPolicy: TaskNotificationPolicy.SILENT,
      laneKey: `knowledge:${owner}`,
      laneLimit: 1,
      runner: async (_ignored, { onEvent, signal, taskId }) => {
        const result = await this.provider.ingest({
          source: { type: 'file', path, name },
        }, {
          ownerId: owner,
          taskId,
          signal,
          onEvent,
        })
        const document = result?.document || result
        return {
          content: document?.title
            ? `已把《${document.title}》收进资料库。`
            : `已把「${name}」收进资料库。`,
          metadata: { knowledgeDocument: document },
        }
      },
    })
    return { task, target: name }
  }

  async list({ ownerId } = {}) {
    const result = await this.provider.list({}, { ownerId: clean(ownerId) })
    return Array.isArray(result) ? result : result?.documents || []
  }

  async remove({ ownerId, documentId } = {}) {
    return this.provider.remove({ documentId: clean(documentId) }, {
      ownerId: clean(ownerId),
    })
  }
}
