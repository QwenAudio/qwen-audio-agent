import express from 'express'
import { createServer } from 'http'
import { randomUUID } from 'node:crypto'
import { resolve } from 'path'
import { agent as defaultAgent } from '../agent/agent-client.mjs'
import { BackendAvailability } from '../agent/backend-availability.mjs'
import { BackendWorkRuntime } from '../backend/backend-work-runtime.mjs'
import { config as defaultConfig } from '../core/config.mjs'
import { logger as defaultLogger, runWithLogContext } from '../core/logger.mjs'
import { conversationSync as defaultConversationSync } from '../conversation/conversation-sync.mjs'
import { InputAssetRegistry } from '../voice/input-asset-registry.mjs'
import { IdentityManager } from '../core/identity.mjs'
import { FrontendNotesStore } from '../conversation/frontend-notes.mjs'
import { MemoryAudit } from '../conversation/memory-audit.mjs'
import {
  MemoryExtractor,
  createExtractorLlmCall,
} from '../conversation/memory-extractor.mjs'
import { FrontendMemoryService } from '../conversation/frontend-memory-service.mjs'
import { MarkdownContextStore } from '../conversation/markdown-context-store.mjs'
import { FrontendMemoryRuntime } from '../conversation/memory-runtime.mjs'
import { SessionConversationHistory } from './session-conversation-history.mjs'
import { PreferenceCandidateStore } from '../conversation/preference-candidate-store.mjs'
import { PreferenceCandidatePool } from '../conversation/preference-candidates.mjs'
import { PreferencePromoter } from '../conversation/preference-promoter.mjs'
import { ProfileObserver } from '../conversation/profile-observer.mjs'
import { SessionDigestPool } from '../conversation/session-digest.mjs'
import { SessionSummariser } from '../conversation/session-summariser.mjs'
import {
  DomainImportError,
  DomainLibrary,
  classifySource,
} from '../domain/domain-library.mjs'
import { DomainSummariser } from '../domain/domain-summariser.mjs'
import { enforceSameOrigin } from '../core/request-security.mjs'
import {
  GATEWAY_CAPABILITIES,
  GATEWAY_PROTOCOL_VERSION,
} from '../core/gateway-protocol.mjs'
import { attachRealtimeGateway } from '../voice/realtime-gateway.mjs'
import {
  defaultRealtimeProviderRegistry,
  describeActiveRealtime,
} from '../voice/realtime-provider.mjs'
import { InputArbitration } from '../voice/input-arbitration.mjs'
import { SessionPermissionPolicy } from '../voice/session-permission-policy.mjs'
import {
  taskManager as defaultTaskManager,
  taskStore as defaultTaskStore,
  taskSessionJournal as defaultTaskSessionJournal,
} from '../task/task-manager.mjs'
import { ReminderScheduler } from '../task/reminder-scheduler.mjs'
import { webDistributionPath } from '../core/install-paths.mjs'
import { installOfflineNotifications } from './offline-notifications.mjs'
import {
  FrontendRetrievalRuntime,
} from '../frontend/retrieval/frontend-retrieval-runtime.mjs'
import { createWebSearchProvider } from '../providers/search/factory.mjs'
import { FrontendKnowledgeRuntime } from '../frontend/knowledge/knowledge-runtime.mjs'
import { LocalDomainKnowledgeProvider } from '../frontend/knowledge/local-domain-provider.mjs'
import { assertFrontendToolSource } from '../frontend/tools/frontend-tool-source.mjs'
import { FrontendMcpClient } from '../providers/mcp/frontend-mcp-client.mjs'
import {
  loadFrontendMcpConfiguration,
} from '../providers/mcp/frontend-mcp-config.mjs'
import {
  FrontendOpenApiAdapter,
} from '../providers/openapi/frontend-openapi-adapter.mjs'
import {
  loadFrontendOpenApiConfiguration,
} from '../providers/openapi/frontend-openapi-config.mjs'
import {
  projectGatewayTaskEvent,
  projectGatewayTaskSnapshot,
} from '../transport/gateway-task-event-projector.mjs'
import {
  projectGatewayTaskEventForFormat,
} from '../transport/agui-event-projector.mjs'
import { replaySession } from '../session/session-replay.mjs'
import { GatewayClientCommandRuntime } from '../client/client-command-runtime.mjs'
import {
  BUILTIN_CLIENT_EVENT_DEFINITIONS,
  ClientEventDefinitionRegistry,
  GatewayEventRouter,
} from '../client/client-event-router.mjs'

export function createGatewayApplication({
  config = defaultConfig,
  agent = defaultAgent,
  backendRuntime = null,
  conversationSync = defaultConversationSync,
  inputAssets = null,
  taskManager = defaultTaskManager,
  taskStore = defaultTaskStore,
  logger = defaultLogger,
  parentPort = process.parentPort,
  autoStart = true,
  realtimeProviderRegistry = defaultRealtimeProviderRegistry,
  realtimeProvider = config.audioProvider,
  webSearchProvider = undefined,
  urlFetcher = undefined,
  frontendRetrieval = null,
  memoryProvider = undefined,
  frontendMemory = null,
  knowledgeProvider = null,
  // Compatibility alias for embedders that adopted the original injection name.
  knowledgeRetrievalProvider = null,
  frontendKnowledge = null,
  frontendMcp = undefined,
  frontendOpenApi = undefined,
  sessionJournal = null,
  conversationHistory = null,
  taskAnnouncementFactory = undefined,
  clientCommandRuntime = null,
  clientEventRouter = null,
  clientEventDefinitions = [],
  spawnThinkingDescription = '',
} = {}) {
const workBackend = backendRuntime || new BackendWorkRuntime({ backend: agent })
const sessionJournalRuntime = sessionJournal || defaultTaskSessionJournal
const conversationHistoryRuntime = conversationHistory || new SessionConversationHistory({
  conversationSync,
  sessionJournal: sessionJournalRuntime,
  logger,
})
const restoredConversationMessages = conversationHistoryRuntime.start?.() || 0
if (restoredConversationMessages) {
  logger.info('conversation_history.restored', {
    messages: restoredConversationMessages,
  })
}
const inputAssetRegistry = inputAssets || new InputAssetRegistry({
  sessionTtlMs: config.conversationSessionTtlMs,
  maxSessions: config.maxConversationSessions,
})
const retrievalRuntime = frontendRetrieval || new FrontendRetrievalRuntime({
  searchProvider: webSearchProvider === undefined
    ? createWebSearchProvider(config)
    : webSearchProvider,
  ...(urlFetcher === undefined ? {} : { urlFetcher }),
})
const frontendMcpRuntime = frontendMcp === undefined
  ? new FrontendMcpClient({
      configuration: loadFrontendMcpConfiguration({
        filePath: config.frontendMcpConfigPath || '',
      }),
    })
  : frontendMcp
const frontendOpenApiRuntime = frontendOpenApi === undefined
  ? new FrontendOpenApiAdapter({
      configuration: loadFrontendOpenApiConfiguration({
        filePath: config.frontendOpenApiConfigPath || '',
      }),
    })
  : frontendOpenApi
// TaskManager remains the owner of task state. The journal receives an
// immutable event copy so recovery and replay do not depend on its in-memory
// Map or on the current task projection.
const unsubscribeSessionTaskJournal = taskManager.subscribe(event => {
  const task = event?.task
  if (!task?.id) return
  sessionJournalRuntime.append({
    ownerId: event.ownerId || task.ownerId,
    sessionId: task.sessionId || 'main',
    event: {
      type: 'qwaudio/task/event',
      eventId: event.eventId || randomUUID(),
      turnId: task.turnId || null,
      taskId: task.id,
      source: 'task-manager',
      payload: {
        domainType: event.type,
        task,
        details: Object.fromEntries(
          Object.entries(event).filter(([key]) => !['type', 'ownerId', 'task'].includes(key)),
        ),
      },
    },
  })
}, { scope: 'all' })
const frontendToolSources = [
  frontendMcpRuntime,
  frontendOpenApiRuntime,
].filter(Boolean).map(source => assertFrontendToolSource(source))
const identityManager = new IdentityManager({
  secret: config.authSecret,
  mode: config.identityMode,
  personalOwnerId: config.personalOwnerId,
})
// 麦克风抢占控制面：外部宿主（输入法、平台应用）需要录音时通过
// /api/input/suspend 宣告，Gateway 责成所有客户端停采；持有过期自动恢复。
const inputArbitration = new InputArbitration({ logger })
taskManager.configureRetention({
  terminalTtlMs: config.taskTerminalTtlMs,
  pendingNotificationTtlMs: config.taskPendingNotificationTtlMs,
  notificationClaimTtlMs: config.taskNotificationClaimTtlMs,
  maxTerminalTasksPerOwner: config.maxTerminalTasksPerOwner,
})
// Recover records missing from the compact task snapshot by replaying the
// latest task projection found in durable Session Journals.
const restoredJournalTasks = taskManager.sessionJournal === sessionJournalRuntime
  ? 0
  : taskManager.restoreFromJournal(sessionJournalRuntime)
if (restoredJournalTasks) {
  logger.info('session_journal.tasks_restored', { count: restoredJournalTasks })
}
taskManager.recoverDelegated({
  canRecover: task => agent.canRecoverDelegatedWork(task),
  runner: (task, context) => agent.recoverDelegatedWork(task, context),
  canceler: async (task, { abort }) => {
    const result = await agent.cancel(task.id, {
      ownerId: task.ownerId,
    })
    abort()
    return result
  },
})
// Offline notification subscriber: if a voice session does not claim a
// pending notification within the delay window, deliver via desktop
// notification (Electron) and WebSocket push.
const unsubscribeOfflineNotifications = installOfflineNotifications({
  taskManager,
  parentPort,
  delayMs: config.offlineNotificationDelayMs,
})
conversationSync.configureRetention({
  sessionTtlMs: config.conversationSessionTtlMs,
  maxSessions: config.maxConversationSessions,
})
// The built-in Markdown provider preserves the existing USER.md/MEMORY.md
// behaviour. Embedders can replace the entire persistence boundary without
// changing Realtime, extraction, or tool handling code.
let defaultMemoryProvider = null
if (memoryProvider === undefined && !frontendMemory) {
  const userDocuments = new MarkdownContextStore({
    filePath: config.userModelPath,
    scope: 'user',
    personalOwnerId: config.personalOwnerId,
    maxChars: 6000,
    template: '# USER',
    onWarning: warning => logger.warn('user_model.persistence_warning', { warning }),
  })
  const memoryDocuments = new MarkdownContextStore({
    filePath: config.frontendMemoryPath,
    scope: 'memory',
    personalOwnerId: config.personalOwnerId,
    maxChars: 8000,
    template: '# MEMORY',
    onWarning: warning => logger.warn('memory.persistence_warning', { warning }),
  })
  defaultMemoryProvider = new FrontendMemoryService({
    userStore: userDocuments,
    memoryStore: memoryDocuments,
  })
}
const memoryProviderRuntime = memoryProvider === undefined
  ? defaultMemoryProvider
  : memoryProvider
const frontendMemoryRuntime = frontendMemory || (memoryProviderRuntime
  ? new FrontendMemoryRuntime({ provider: memoryProviderRuntime })
  : null)
// Restored scheduled tasks submit the same self-contained Work input as live
// requests. Frontend conversation history and memory stay at the frontend.
taskManager.configureScheduledTaskRunner(
  async (objective, context) => workBackend.run({
    objective,
  }, {
    ownerId: context.ownerId,
    sessionId: context.sessionId,
    turnId: context.turnId,
    taskId: context.taskId,
    signal: context.signal,
    onEvent: context.onEvent,
  }),
)
// ReminderScheduler: setTimeout-driven, no polling. Handles overdue
// stagger on restart and re-arming after each fire.
let reminderScheduler = null
if (config.reminderSchedulerEnabled) {
  reminderScheduler = new ReminderScheduler({
    taskManager,
    staggerMs: config.reminderStaggerMs,
    logger,
  })
  reminderScheduler.start()
}
const notesStore = new FrontendNotesStore({
  filePath: config.frontendNotesPath,
  maxOwners: config.maxFrontendMemoryOwners,
  ownerTtlMs: config.frontendMemoryOwnerTtlMs,
  onWarning: warning => logger.warn('notes.persistence_warning', { warning }),
})
// Invisible memory (issue #92): after a voice session closes, a lightweight
// text model reconciles explicit user directives and durable facts through the
// same context service used by the realtime memory tool.
// Without an API key createExtractorLlmCall returns null
// and the extractor stays silently disabled; explicit memories are
// unaffected. ASSISTANT.md is never exposed as a writable document.
const memoryAudit = new MemoryAudit({
  filePath: config.memoryAuditPath,
  onWarning: warning => logger.warn('memory.audit_warning', { warning }),
})
// 记忆类模型调用共用一套凭据与轻量文本模型；没有 API key 时为 null，
// 依赖它的模块各自静默禁用，本地纯语音链路不受影响。
const memoryLlmCall = config.memoryAutoEnabled
  ? createExtractorLlmCall({
      baseUrl: config.memoryBaseUrl,
      apiKey: config.memoryApiKey,
      model: config.memoryModel,
    })
  : null
const memoryExtractor = new MemoryExtractor({
  memoryService: frontendMemoryRuntime,
  conversationSync,
  audit: memoryAudit,
  llmCall: memoryLlmCall,
  logger,
})
// 偏好自更新：观察器从刚结束的会话里推断画像信号 → 槽位池积累跨会话确认 →
// 攒够后由晋升器写入 USER.md 的观察推断段。槽位池必须落盘，否则重启即清零、
// 跨会话确认永远攒不满。观察器需要模型，没有 API key 时它为 null，
// 链路退化成「只有明说路径」——槽位池与晋升器照常空转，不报错。
let preferenceCandidates = null
let preferencePromoter = null
let profileObserver = null
if (config.preferenceLearningEnabled) {
  preferenceCandidates = new PreferenceCandidatePool({
    store: new PreferenceCandidateStore({
      filePath: config.preferenceCandidatePath,
      onWarning: warning => logger.warn('preference.persistence_warning', { warning }),
    }),
  })
  preferencePromoter = new PreferencePromoter({
    // #238 把记忆层抽成 MemoryProvider 之后，同步 Markdown 接口的载体改名为
    // memoryProviderRuntime；晋升器要的正是那套同步 list/apply。
    // 注意它可能为 null（没配 provider 时），promoter 内部靠 enabled() 静默禁用。
    memoryService: memoryProviderRuntime,
    candidatePool: preferenceCandidates,
    audit: memoryAudit,
    logger,
  })
  profileObserver = memoryLlmCall
    ? new ProfileObserver({
        candidatePool: preferenceCandidates,
        conversationSync,
        audit: memoryAudit,
        llmCall: memoryLlmCall,
        logger,
      })
    : null
}
// 会话摘要：只记「聊了哪些话题 + 一句要点」，是 recall 工具的唯一
// 数据来源。刻意不注入 instructions —— 这类数据每场都在变，注进去会让 prompt
// 前缀每场都变、前缀缓存大面积失效。没有 API key 时摘要器为 null，池子空转，
// 工具也不会暴露给模型。
let sessionDigests = null
let sessionSummariser = null
if (config.sessionDigestEnabled) {
  sessionDigests = new SessionDigestPool({
    filePath: config.sessionDigestPath,
    onWarning: warning => logger.warn('session_digest.persistence_warning', { warning }),
  })
  sessionSummariser = memoryLlmCall
    ? new SessionSummariser({
        digestPool: sessionDigests,
        conversationSync,
        audit: memoryAudit,
        llmCall: memoryLlmCall,
        logger,
        // 把本场派过的活沉淀进摘要。排除 control（「查一下那个任务的进展」这个
        // 动作本身）与 reminder（未来要做的事，不属于「做过什么」）。
        // 只取 objective 与 id，状态留给检索时实时读 —— 摘要里存状态会冻结。
        listSessionWork: ({ ownerId, sessionId }) => taskManager
          .list({ ownerId, sessionId })
          .filter(task => task.kind === 'work' || task.kind === 'scheduled_task')
          .map(task => ({ id: task.id, objective: task.objective })),
      })
    : null
}
// 领域资料库：用户导入的手册 / 规章 / 教材。资料本体复制到后端共享 workspace
// 下的 domain/，前端只留一份带摘要的清单 —— 检索与读原文由后端拿着路径自己做。
// 摘要器没有 API key 时为 null：资料照样能导入并交给后端，只是清单里没有
// 「这是什么」那一句，这是刻意的降级顺序。
let domainLibrary = null
let domainSummariser = null
if (config.domainLibraryEnabled) {
  domainLibrary = new DomainLibrary({
    documentDirectory: config.domainDocumentDirectory,
    indexPath: config.domainIndexPath,
    onWarning: warning => logger.warn('domain.persistence_warning', { warning }),
  })
  domainSummariser = memoryLlmCall
    ? new DomainSummariser({
        library: domainLibrary,
        audit: memoryAudit,
        llmCall: memoryLlmCall,
        logger,
      })
    : null
}

// 知识检索 Provider 的装配放在资料库之后，因为本机资料库可以直接作为一个
// Provider 用（见 frontend/knowledge/local-domain-provider.mjs）。
//
// 优先级：宿主显式注入 > 本机资料库兜底。一个 Gateway 只挂一个 Provider ——
// 这是 Provider 模式的正常语义：用户配了企业知识服务说明他已有更完整的方案，
// 那时不该再用这个轻量实现去覆盖它。真要两者并存，宿主自己写一层把两个
// Provider 包起来（按 knowledgeBaseIds 路由或合并结果），那是应用层的自由。
const knowledgeProviderRuntime = knowledgeProvider
  || knowledgeRetrievalProvider
  || (domainLibrary ? new LocalDomainKnowledgeProvider({ library: domainLibrary }) : null)
const frontendKnowledgeRuntime = frontendKnowledge || (knowledgeProviderRuntime
  ? new FrontendKnowledgeRuntime({ provider: knowledgeProviderRuntime })
  : null)
const app = express()
// 资料条目对外的形状。fingerprint 是内部去重用的，不该出现在 API 里；
// path 要给出来 —— 它就是交给后端 Agent 的那个地址，是这套机制的用处所在。
const publicDomainEntry = entry => ({
  id: entry.id,
  title: entry.title,
  gist: entry.gist,
  sections: entry.sections,
  path: entry.path,
  filename: entry.filename,
  bytes: entry.bytes,
  imported_at: entry.importedAt,
  source: entry.source,
  summarised: entry.summarised,
})

// 派一次后台转换：后端把 PDF / Word 的文字提取出来写成 Markdown，写完由这里
// 收录。走普通后台任务，因此进度、通知、取消全部复用既有机制。
//
// 收录这一步刻意放在 runner 里而不是任务完成事件里：这样「转换成功」与
// 「已收录」是同一件事，不存在转好了但没收进来的中间态。
function enqueueDomainConversion({ ownerId, sourcePath, target }) {
  const objective = [
    `把「${sourcePath}」里的文字内容完整提取出来，原样写入「${target.path}」。`,
    '要求：保留原文措辞、标题层级与条目顺序，不要概括、不要改写、不要补充说明、不要翻译。',
    '若文件是扫描件或加密件而无法提取文字，不要编造内容，直接说明原因。',
    '写好之后只回复一句确认，不要把提取到的正文贴回来。',
  ].join('\n')
  return taskManager.create({
    objective,
    ownerId,
    // 与后台活共用一条泳道：转换是一次普通的后台执行，不该和用户派的活抢并发。
    laneKey: `backend:${ownerId}`,
    laneLimit: 1,
    runner: async (_ignored, { onEvent, signal, taskId }) => {
      // 必须经 BackendPort（workBackend）而不是直接摸具体后台实现 —— 换适配器时
      // 这里不该跟着改。参数形状与上面的 configureScheduledTaskRunner 保持一致。
      //
      // 不传 workingDirectory：BackendPort 的 submit 契约只接受
      // { id, ownerId, objective, instruction, inputParts }，没有工作目录这一项。
      // 目标位置靠 objective 里的绝对路径表达（conversionTarget 返回的 path 是
      // join(documentDirectory, filename)），所以后端不依赖 cwd 也能写对地方。
      const result = await workBackend.run({
        objective,
      }, { ownerId, taskId, signal, onEvent })

      // 后端说完成不等于真的写了 —— 以文件系统为准，不以它的回话为准。
      let entry
      try {
        entry = domainLibrary.import({ ownerId, sourcePath: target.path })
      } catch (error) {
        throw new Error(
          `后台没有产出可用的文本文件（${error.message}）。`
          + '这个文件可能是扫描件或加密件，请先自行转成 Markdown 再导入。',
        )
      }
      const summarised = domainSummariser
        ? await domainSummariser.maybeRun({ ownerId, id: entry.id })
        : null
      const document = publicDomainEntry(summarised || entry)
      return {
        content: `已把《${document.title}》收进资料库。`,
        metadata: { domainDocument: document, backendReply: result?.content || '' },
      }
    },
  })
}
const permissionPolicy = new SessionPermissionPolicy({
  ttlMs: config.conversationSessionTtlMs,
  maxSessions: config.maxConversationSessions,
})
const runtimeCommands = clientCommandRuntime || new GatewayClientCommandRuntime({
  taskManager,
  backendRuntime: workBackend,
  conversationHistory: conversationHistoryRuntime,
  respondAuthorization: (taskId, id, decision, options) => (
    agent.respondAuthorization(taskId, id, decision, options)
  ),
  respondInput: (taskId, id, response, options) => (
    agent.respondInput(taskId, id, response, options)
  ),
  permissionPolicy,
  logger,
})
const gatewayEventRouter = clientEventRouter || new GatewayEventRouter({
  registry: new ClientEventDefinitionRegistry({
    definitions: [
      ...BUILTIN_CLIENT_EVENT_DEFINITIONS,
      ...clientEventDefinitions,
    ],
  }),
})

app.disable('x-powered-by')
app.use(enforceSameOrigin)
app.use((req, res, next) => {
  req.identity = identityManager.resolveHttp(req, res)
  const requestId = randomUUID()
  res.setHeader('X-Request-Id', requestId)
  runWithLogContext({
    requestId,
    ownerId: req.identity?.ownerId,
  }, next)
})
app.use((req, res, next) => {
  const startedAt = Date.now()
  res.once('finish', () => {
    const fields = {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
    }
    if (res.statusCode >= 500) {
      logger.warn('http.request_failed', fields)
    } else {
      logger.debug('http.request_completed', fields)
    }
  })
  next()
})
app.use(express.json({ limit: '1mb' }))

let realtimeGateway

app.get('/livez', (req, res) => {
  res.json({ ok: true, status: 'live' })
})

app.get('/readyz', (req, res) => {
  res.json({ ok: true, status: 'ready' })
})

app.get('/api/health', (req, res) => {
  const backend = agent.status()
  const backendDescription = agent.describe()
  const realtime = describeActiveRealtime(realtimeProvider, {
    registry: realtimeProviderRegistry,
  })
  res.json({
    // Gateway liveness is independent from optional backend readiness.
    ok: true,
    status: 'ready',
    // Contract surface: clients branch on a capability, not a product version.
    protocolVersion: GATEWAY_PROTOCOL_VERSION,
    capabilities: GATEWAY_CAPABILITIES,
    gatewayInstanceId: process.env.QWEN_AUDIO_GATEWAY_INSTANCE_ID || null,
    gatewayStartedAt: process.env.QWEN_AUDIO_GATEWAY_STARTED_AT || null,
    inputSuspension: inputArbitration.status(),
    voiceConfigured: realtime.configured,
    realtimeProvider: realtime.provider,
    realtimeLabel: realtime.label,
    realtimeModel: realtime.model,
    realtimeModelProfile: realtime.modelProfile,
    realtimeModelCatalog: realtime.modelCatalog,
    realtimeInputSampleRate: realtime.inputSampleRate,
    realtimeConfigurationSignature: realtime.configurationSignature,
    // Front ends a client may select for its session through the realtime
    // connect event.
    realtimeProviders: realtime.providers,
    announceIntoContext: config.announceIntoContext,
    resultContextMaxChars: config.resultContextMaxChars,
    announcementBatchMs: config.announcementBatchMs,
    announcementQuietMs: config.announcementQuietMs,
    frontendMemory: frontendMemoryRuntime?.health() || {
      ok: true,
      configured: false,
      provider: null,
    },
    frontendProfile: config.frontendProfile || {
      configured: false,
      name: 'default',
      description: '',
    },
    frontendRetrieval: retrievalRuntime.describe(),
    frontendKnowledge: frontendKnowledgeRuntime?.describe() || {
      configured: false,
      capabilities: [],
      provider: null,
    },
    frontendMcp: frontendMcpRuntime?.health?.() || {
      ok: true,
      initialized: true,
      tools: 0,
      servers: [],
    },
    frontendOpenApi: frontendOpenApiRuntime?.health?.() || {
      ok: true,
      initialized: true,
      tools: 0,
      apis: [],
    },
    notes: notesStore.health(),
    taskStore: taskStore.health(),
    identityMode: config.identityMode,
    voiceClients: realtimeGateway?.status() || {
      connected: 0,
      activeOwners: 0,
      byType: {},
    },
    backend: {
      ...backendDescription,
      ...backend,
    },
  })
})

// Provider-neutral memory control plane for replaceable Conversation Clients.
// It exposes the same bounded documents used by Realtime without leaking the
// Markdown default or any injected provider's persistence details.
app.get('/api/memory', (req, res, next) => {
  if (!frontendMemoryRuntime) {
    return res.status(404).json({ error: 'frontend memory is not configured' })
  }
  try {
    return res.json({
      documents: frontendMemoryRuntime.list(req.identity.ownerId),
    })
  } catch (error) {
    return next(error)
  }
})

app.patch('/api/memory', async (req, res, next) => {
  if (!frontendMemoryRuntime) {
    return res.status(404).json({ error: 'frontend memory is not configured' })
  }
  const changes = req.body?.changes
  if (!Array.isArray(changes) || changes.length === 0) {
    return res.status(400).json({ error: 'changes must be a non-empty array' })
  }
  try {
    return res.json(await frontendMemoryRuntime.apply(
      req.identity.ownerId,
      changes,
      { source: 'gateway-memory-api' },
    ))
  } catch (error) {
    if (error?.code === 'stale_document') {
      return res.status(409).json({ error: error.message, code: error.code })
    }
    if (['invalid_edit', 'ambiguous_edit', 'edit_not_found'].includes(error?.code)) {
      return res.status(400).json({ error: error.message, code: error.code })
    }
    return next(error)
  }
})

// Host control plane for microphone arbitration. The host announces that it is
// taking the microphone and the Gateway commands its clients to stop capturing.
// Both calls are idempotent per owner, and a suspension expires on its own so a
// host that crashes cannot silence the Gateway for good.
app.post('/api/input/suspend', (req, res) => {
  try {
    return res.json(inputArbitration.suspend({
      owner: req.body?.owner,
      reason: req.body?.reason,
      ttlMs: req.body?.ttlMs,
    }))
  } catch (error) {
    if (error?.code === 'QWAUDIO_INPUT_OWNER_REQUIRED') {
      return res.status(400).json({ error: error.message, code: error.code })
    }
    throw error
  }
})

app.post('/api/input/resume', (req, res) => {
  res.json(inputArbitration.resume({ owner: req.body?.owner }))
})

app.get('/api/input', (req, res) => {
  res.json(inputArbitration.status())
})

app.get('/api/backend/ui', async (req, res, next) => {
  if (!agent.describe().capabilities.backendUi) {
    return res.status(404).json({ error: '当前后台 Agent 没有独立的 Web 地址' })
  }
  try {
    const url = await agent.uiUrl({ ownerId: req.identity.ownerId })
    if (!url) {
      return res.status(404).json({
        error: '当前后台 Agent 没有独立的 Web 地址',
      })
    }
    return res.redirect(302, url)
  } catch (error) {
    return next(error)
  }
})

app.get('/api/tasks', (req, res) => {
  res.json({
    tasks: runtimeCommands.listTasks({
      session_id: req.query.sessionId,
      active: req.query.active === 'true',
      limit: Number.MAX_SAFE_INTEGER,
    }, { ownerId: req.identity.ownerId, allSessions: true }),
  })
})

// Durable session facts are intentionally exposed separately from UI state.
// Clients may use this for reconnect/recovery; projections should not need to
// understand the on-disk JSONL format.
// 资料库。入口是「给一条本机路径」而不是上传字节流 —— 这是本地服务，用户手上
// 本来就有文件，复制一份比经 base64 中转再落盘简单得多。web 端的按钮只要把
// 选中文件的路径 POST 过来即可。
app.get('/api/domain', (req, res) => {
  if (!domainLibrary) {
    res.status(404).json({ error: 'domain_library_disabled' })
    return
  }
  res.json({
    documents: domainLibrary.list(req.identity.ownerId).map(publicDomainEntry),
  })
})

app.post('/api/domain/import', async (req, res, next) => {
  if (!domainLibrary) {
    res.status(404).json({ error: 'domain_library_disabled' })
    return
  }
  const ownerId = req.identity.ownerId
  const sourcePath = req.body?.path

  // PDF / Word 先交给后端提取文字。刻意不让它把全文回传：模型的输出上限装不下
  // 一份手册，而且「原样复述」正是它最不可靠的事 —— 结果会是摘要或改写，而我们
  // 要的恰恰是原文保真。后端的 cwd 就是这个 workspace，让它直接写文件，
  // 回一句写好了即可。
  if (classifySource(sourcePath) === 'convertible') {
    let target
    try {
      target = domainLibrary.conversionTarget({ ownerId, sourcePath })
    } catch (error) {
      if (error instanceof DomainImportError) {
        res.status(400).json({ error: error.code, message: error.message })
        return
      }
      return next(error)
    }
    const task = enqueueDomainConversion({ ownerId, sourcePath, target })
    res.status(202).json({ status: 'converting', task_id: task.id, target: target.filename })
    return
  }

  let entry
  try {
    entry = domainLibrary.import({ ownerId, sourcePath })
  } catch (error) {
    if (error instanceof DomainImportError) {
      res.status(400).json({ error: error.code, message: error.message })
      return
    }
    return next(error)
  }
  // 摘要要等：导入是用户点一下按钮的动作，它愿意等一次模型调用换一句
  // 「这是什么」，而且紧接着的问答就可能用到。失败也照常返回已收下的条目。
  const summarised = domainSummariser
    ? await domainSummariser.maybeRun({ ownerId, id: entry.id })
    : null
  res.json({ document: publicDomainEntry(summarised || entry) })
})

app.delete('/api/domain/:id', (req, res) => {
  if (!domainLibrary) {
    res.status(404).json({ error: 'domain_library_disabled' })
    return
  }
  const removed = domainLibrary.remove({
    ownerId: req.identity.ownerId,
    id: req.params.id,
  })
  if (!removed) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  res.json({ removed: publicDomainEntry(removed) })
})

app.get('/api/timeline', (req, res) => {
  const items = taskManager.list({
    ownerId: req.identity.ownerId,
    sessionId: req.query.sessionId,
  })
    .filter(task => task.presentation?.inline?.content)
    .map(task => ({
      id: `inline_${task.id}`,
      taskId: task.id,
      createdAt: task.completedAt || task.createdAt,
      ...task.presentation.inline,
    }))
    .sort((left, right) => left.createdAt - right.createdAt)
  res.json({ items })
})

// Durable session facts are intentionally exposed separately from the UI
// timeline. Clients may use this for reconnect/recovery; projections should
// not need to understand the on-disk JSONL format.
app.get('/api/sessions/:sessionId/events', async (req, res, next) => {
  try {
    const events = await sessionJournalRuntime.read(
      req.identity.ownerId,
      req.params.sessionId,
    )
    res.json({ events })
  } catch (error) {
    next(error)
  }
})

app.get('/api/sessions/:sessionId/replay', async (req, res, next) => {
  try {
    const events = await sessionJournalRuntime.read(
      req.identity.ownerId,
      req.params.sessionId,
    )
    res.json({ replay: replaySession(events, { sessionId: req.params.sessionId }) })
  } catch (error) {
    next(error)
  }
})

// Stable, bounded UI projection. Clients never depend on Session Journal
// records or diagnostic logs, and Realtime consumes this same projection.
app.get('/api/conversations/:sessionId/messages', async (req, res, next) => {
  try {
    const messages = await runtimeCommands.history({
      session_id: req.params.sessionId,
    }, { ownerId: req.identity.ownerId })
    res.json({ messages })
  } catch (error) {
    next(error)
  }
})

app.get('/api/tasks/:id', (req, res) => {
  try {
    res.json(runtimeCommands.getTask(req.params.id, {
      ownerId: req.identity.ownerId,
    }))
  } catch (error) {
    if (error?.code === 'task_not_found') {
      return res.status(404).json({ error: 'task not found' })
    }
    res.status(400).json({ error: error.message })
  }
})

app.delete('/api/tasks/:id', async (req, res, next) => {
  try {
    const task = await runtimeCommands.cancelTask(req.params.id, {
      ownerId: req.identity.ownerId,
    }, { wait: true })
    res.json(task)
  } catch (error) {
    if (error?.code === 'task_not_found') {
      return res.status(404).json({ error: 'task not found' })
    }
    if (error?.code === 'task_not_cancellable') {
      return res.status(409).json({
        error: 'task is no longer active',
        task: runtimeCommands.getTask(req.params.id, {
          ownerId: req.identity.ownerId,
        }),
      })
    }
    next(error)
  }
})

app.post('/api/permissions/:id', async (req, res, next) => {
  const decision = String(req.body?.decision || '')
  if (!['once', 'always', 'reject'].includes(decision)) {
    return res.status(400).json({
      error: 'decision must be once, always, or reject',
    })
  }
  try {
    const permission = await runtimeCommands.respondPermission({
      permission_id: req.params.id,
      decision,
    }, { ownerId: req.identity.ownerId })
    return res.json(permission)
  } catch (error) {
    if (error?.status === 404 || error?.code === 'permission_not_found') {
      return res.status(404).json({ error: error.message })
    }
    return next(error)
  }
})

app.get('/api/tasks/:id/events', (req, res) => {
  const task = taskManager.get(req.params.id, { ownerId: req.identity.ownerId })
  if (!task) return res.status(404).json({ error: 'task not found' })
  const projectEvent = event => projectGatewayTaskEventForFormat(
    event,
    req.query.format,
  )
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  const write = event => res.write(`data: ${JSON.stringify(event)}\n\n`)
  write(projectEvent(projectGatewayTaskSnapshot(task)))
  const unsubscribe = taskManager.subscribe(event => {
    if (event.ownerId === req.identity.ownerId && event.task.id === req.params.id) {
      const publicEvent = projectGatewayTaskEvent(event)
      if (publicEvent) write(projectEvent(publicEvent))
    }
  })
  res.on('close', unsubscribe)
})

const webDist = webDistributionPath()
// Imported orb skins live under the config directory. The orb page fetches
// `skins/<id>/...` relative to its own origin, so serving them here means a
// host that points a window at the Gateway needs no separate asset server.
// Static assets only, no fallback to index.html for missing files.
app.use('/skins', express.static(resolve(config.configDirectory, 'skins'), {
  index: false,
  redirect: false,
  dotfiles: 'ignore',
  // Imports and removals must be visible on the next orb reload.
  setHeaders: response => response.setHeader('cache-control', 'no-store'),
}), (req, res) => res.status(404).json({ error: 'not found' }))
app.use(express.static(webDist))
app.get('*', (req, res) => res.sendFile(resolve(webDist, 'index.html')))
app.use((error, req, res, next) => {
  logger.error('http.unhandled_error', {
    method: req.method,
    path: req.path,
    error,
  })
  next(error)
})

const server = createServer(app)
// Receipt-based tool acceptance reads backend availability from this cache
// instead of probing per spawn_thinking call; the snapshot answers
// synchronously and refreshes itself in the background.
const backendAvailability = new BackendAvailability({
  probe: async () => {
    if (!agent.enabled) return { configured: false, ok: false }
    const health = await agent.health()
    return {
      configured: true,
      ok: health.ok === true,
      // A managed service and its adapter transport come online in stages. Preserve
      // that distinction so receipt-based work is not rejected from a stale
      // cold-start probe, and keep advancing initialization in the background.
      transient: health.status === 'starting'
        || ['NOT_STARTED', 'STARTING', 'BACKEND_STARTING'].includes(health.code),
    }
  },
})
backendAvailability.refresh()
realtimeGateway = attachRealtimeGateway(server, {
  identityManager,
  memoryService: frontendMemoryRuntime,
  memoryExtractor,
  preferencePromoter,
  profileObserver,
  sessionDigests,
  sessionSummariser,
  domainLibrary,
  notesStore,
  backendRuntime: workBackend,
  backendAvailability,
  respondAuthorization: (taskId, id, decision, options) => (
    agent.respondAuthorization(taskId, id, decision, options)
  ),
  respondInput: (taskId, id, response, options) => (
    agent.respondInput(taskId, id, response, options)
  ),
  permissionPolicy,
  inputAssets: inputAssetRegistry,
  inputArbitration,
  realtimeProviderRegistry,
  defaultRealtimeProvider: realtimeProvider,
  frontendRetrieval: retrievalRuntime,
  frontendKnowledge: frontendKnowledgeRuntime,
  frontendToolSources,
  spawnThinkingDescription,
  taskAnnouncementFactory,
  clientCommandRuntime: runtimeCommands,
  clientEventRouter: gatewayEventRouter,
})
const start = ({ host = config.host, port = config.port } = {}) => {
  if (server.listening) return server
  server.listen(port, host, () => {
    const address = server.address()
    const boundPort = address && typeof address === 'object' ? address.port : port
    const origin = `http://${host}:${boundPort}`
    const readyReport = {
      type: 'qwen-audio-agent:gateway-ready',
      origin,
      instanceId: process.env.QWEN_AUDIO_GATEWAY_INSTANCE_ID || null,
    }
    if (parentPort) {
      // Electron utilityProcess.
      parentPort.postMessage(readyReport)
    } else if (process.send) {
      // Plain Node child_process.fork — how a non-Electron host embeds us.
      process.send(readyReport)
    }
    logger.info('gateway.ready', {
      origin,
      backend: agent.describe?.()?.protocol || config.agentProtocol || 'none',
      realtimeProvider,
    }, `qwen-audio-agent running at ${origin}`)
  })
  return server
}

let closePromise = null
const close = () => {
  if (closePromise) return closePromise
  closePromise = Promise.resolve().then(async () => {
    backendAvailability.close()
    unsubscribeOfflineNotifications?.()
    reminderScheduler?.close()
    // A Gateway that stops serving cannot honour a resume, so held state must
    // not survive into the next run.
    inputArbitration.close()
    await realtimeGateway?.close?.()
    await frontendMcpRuntime?.close?.()
    await frontendOpenApiRuntime?.close?.()
    await frontendKnowledgeRuntime?.close?.()
    await frontendMemoryRuntime?.close?.()
    unsubscribeSessionTaskJournal?.()
    conversationHistoryRuntime.close?.()
    await sessionJournalRuntime.flush()
    await taskStore?.flush?.()
    if (!server.listening) return
    await new Promise((resolveClose, rejectClose) => {
      server.close(error => {
        if (error) rejectClose(error)
        else resolveClose()
      })
    })
  })
  return closePromise
}

if (autoStart) start()

return {
  app,
  server,
  start,
  close,
  services: {
    agent,
    backendAvailability,
    conversationSync,
    conversationHistory: conversationHistoryRuntime,
    backendRuntime: workBackend,
    // Preserve the original service handle for embedders using the built-in
    // synchronous Markdown API. New integrations should use frontendMemory.
    frontendMemoryService: memoryProviderRuntime,
    frontendMemory: frontendMemoryRuntime,
    memoryProvider: memoryProviderRuntime,
    frontendRetrieval: retrievalRuntime,
    frontendKnowledge: frontendKnowledgeRuntime,
    frontendMcp: frontendMcpRuntime,
    frontendOpenApi: frontendOpenApiRuntime,
    runtimeCommands,
    gatewayEventRouter,
    knowledgeProvider: knowledgeProviderRuntime,
    identityManager,
    inputArbitration,
    inputAssets: inputAssetRegistry,
    notesStore,
    permissionPolicy,
    preferenceCandidates,
    preferencePromoter,
    profileObserver,
    realtimeGateway,
    sessionDigests,
    sessionSummariser,
    domainLibrary,
    domainSummariser,
    taskManager,
    taskStore,
    sessionJournal: sessionJournalRuntime,
  },
}
}
