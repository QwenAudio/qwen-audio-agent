import { KnowledgeLibrary } from './providers/local/library.mjs'
import { KnowledgeSummariser } from './providers/local/summariser.mjs'
import { LocalKnowledgeProvider } from './providers/local/provider.mjs'
import { AgentDocumentConverter } from './providers/local/document-converter.mjs'
import { FrontendKnowledgeRuntime } from './runtime.mjs'
import { KnowledgeLibraryService } from './library-service.mjs'
import { supportsKnowledgeManagement } from './provider.mjs'

export function createKnowledgeModule({ config, logger, textModelCall, audit,
  workBackend, agent, backendRuntime, taskManager, knowledgeProvider,
  knowledgeRetrievalProvider, frontendKnowledge, knowledgeRuntimeOptions } = {}) {
  // 内置资料存储：用户导入的手册 / 规章 / 教材。资料本体保存在共享 knowledge/documents/
  // 目录，Provider 直接读取 Markdown 片段完成基础检索；后台 Agent 只可作为复杂
  // 文档入库时的隔离转换器。
  let domainLibrary = null
  let domainSummariser = null
  if (config.domainLibraryEnabled) {
    domainLibrary = new KnowledgeLibrary({
      documentDirectory: config.domainDocumentDirectory,
      indexPath: config.domainIndexPath,
      onWarning: warning => logger.warn('domain.persistence_warning', { warning }),
    })
    domainSummariser = textModelCall
      ? new KnowledgeSummariser({
          library: domainLibrary,
          audit,
          llmCall: textModelCall,
          logger,
        })
      : null
  }

  // 知识检索 Provider 的装配放在资料库之后，因为本机资料库可以直接作为一个
  // Provider 使用（见 knowledge/providers/local/provider.mjs）。
  //
  // 优先级：宿主显式注入 > 本机资料库兜底。一个 Gateway 只挂一个 Provider ——
  // 这是 Provider 模式的正常语义：用户配了企业知识服务说明他已有更完整的方案，
  // 那时不该再用这个轻量实现去覆盖它。真要两者并存，宿主自己写一层把两个
  // Provider 包起来（按 knowledgeBaseIds 路由或合并结果），那是应用层的自由。
  const canConvertDocuments = typeof workBackend.runIsolated === 'function'
    && (backendRuntime != null || agent.describe?.()?.enabled !== false)
  const knowledgeProviderRuntime = knowledgeProvider
    || knowledgeRetrievalProvider
    || (domainLibrary ? new LocalKnowledgeProvider({
        library: domainLibrary,
        summariser: domainSummariser,
        documentConverter: canConvertDocuments
          ? new AgentDocumentConverter({ backendRuntime: workBackend })
          : null,
      }) : null)
  const frontendKnowledgeRuntime = frontendKnowledge || (knowledgeProviderRuntime
    ? new FrontendKnowledgeRuntime({
        ...(knowledgeRuntimeOptions && typeof knowledgeRuntimeOptions === 'object'
          ? knowledgeRuntimeOptions
          : {}),
        provider: knowledgeProviderRuntime,
      })
    : null)
  const knowledgeLibrary = knowledgeProviderRuntime
    && supportsKnowledgeManagement(knowledgeProviderRuntime)
    ? new KnowledgeLibraryService({
        provider: knowledgeProviderRuntime,
        taskManager,
      })
    : null
  return {
    services: {
      frontendKnowledge: frontendKnowledgeRuntime, knowledgeProvider: knowledgeProviderRuntime,
      knowledgeLibrary, domainLibrary, domainSummariser,
    },
    close: () => frontendKnowledgeRuntime?.close?.(),
    mountRoutes(app) {
      // 资料库。入口是「给一条本机路径」而不是上传字节流 —— 这是本地服务，用户手上
      // 本来就有文件，复制一份比经 base64 中转再落盘简单得多。web 端的按钮只要把
      // 选中文件的路径 POST 过来即可。
      app.get('/api/domain', async (req, res, next) => {
        if (!knowledgeLibrary) {
          res.status(404).json({ error: 'domain_library_disabled' })
          return
        }
        try {
          res.json({
            documents: await knowledgeLibrary.list({ ownerId: req.identity.ownerId }),
          })
        } catch (error) {
          next(error)
        }
      })

      app.post('/api/domain/import', (req, res, next) => {
        if (!knowledgeLibrary) {
          res.status(404).json({ error: 'domain_library_disabled' })
          return
        }
        try {
          const { task, target } = knowledgeLibrary.startIngestion({
            ownerId: req.identity.ownerId,
            sourcePath: req.body?.path,
          })
          res.status(202).json({
            status: 'ingesting',
            task_id: task.id,
            target,
          })
        } catch (error) {
          next(error)
        }
      })

      app.delete('/api/domain/:id', async (req, res, next) => {
        if (!knowledgeLibrary) {
          res.status(404).json({ error: 'domain_library_disabled' })
          return
        }
        try {
          const result = await knowledgeLibrary.remove({
            ownerId: req.identity.ownerId,
            documentId: req.params.id,
          })
          if (!result?.removed) {
            res.status(404).json({ error: 'not_found' })
            return
          }
          res.json({ removed: result.document })
        } catch (error) {
          next(error)
        }
      })
    },
  }
}
