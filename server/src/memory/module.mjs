import { FrontendMemoryRuntime } from './runtime.mjs'
import { createConfiguredMemoryProvider } from './provider-factory.mjs'
import { MemoryExtractor } from './learning/extractor.mjs'
import { PreferenceCandidateStore } from './learning/preference-candidate-store.mjs'
import { PreferenceCandidatePool } from './learning/preference-candidates.mjs'
import { PreferencePromoter } from './learning/preference-promoter.mjs'
import { ProfileObserver } from './learning/profile-observer.mjs'
import { MemorySessionObserver } from './session-observer.mjs'

export function createMemoryModule({ config, logger, conversationSync, textModelCall,
  audit, memoryProvider, frontendMemory } = {}) {
  let defaultMemoryProvider = null
  if (memoryProvider === undefined && !frontendMemory) {
    defaultMemoryProvider = createConfiguredMemoryProvider({
      config,
      logger,
    })
  }
  const memoryProviderRuntime = memoryProvider === undefined
    ? defaultMemoryProvider
    : memoryProvider
  const frontendMemoryRuntime = frontendMemory || (memoryProviderRuntime
    ? new FrontendMemoryRuntime({ provider: memoryProviderRuntime })
    : null)
  const providerOwnsSessionObservation = (
    typeof frontendMemoryRuntime?.ownsSessionObservation === 'function'
    && frontendMemoryRuntime.ownsSessionObservation() === true
  )
  const memoryExtractor = providerOwnsSessionObservation
    ? null
    : new MemoryExtractor({
        memoryService: frontendMemoryRuntime,
        conversationSync,
        audit,
        llmCall: textModelCall,
        logger,
      })
  // 偏好自更新：观察器从刚结束的会话里推断画像信号 → 槽位池积累跨会话确认 →
  // 攒够后由晋升器写入 USER.md 的观察推断段。槽位池必须落盘，否则重启即清零、
  // 跨会话确认永远攒不满。观察器需要模型，没有 API key 时它为 null，
  // 链路退化成「只有明说路径」——槽位池与晋升器照常空转，不报错。
  let preferenceCandidates = null
  let preferencePromoter = null
  let profileObserver = null
  if (config.preferenceLearningEnabled && !providerOwnsSessionObservation) {
    preferenceCandidates = new PreferenceCandidatePool({
      store: new PreferenceCandidateStore({
        filePath: config.preferenceCandidatePath,
        onWarning: warning => logger.warn('preference.persistence_warning', { warning }),
      }),
    })
    preferencePromoter = new PreferencePromoter({
      // Promotion uses the provider’s synchronous snapshot; without a provider
      // the promoter stays disabled.
      memoryService: memoryProviderRuntime,
      candidatePool: preferenceCandidates,
      audit,
      logger,
    })
    profileObserver = textModelCall
      ? new ProfileObserver({
          candidatePool: preferenceCandidates,
          conversationSync,
          audit,
          llmCall: textModelCall,
          logger,
        })
      : null
  }
  // A successful explicit edit establishes a new learning boundary. Do not
  // clear chat history: only pre-edit evidence and in-flight learning expire.
  const unsubscribeLearning = (memoryExtractor?.enabled() || preferencePromoter?.enabled()
    || providerOwnsSessionObservation)
    ? frontendMemoryRuntime?.subscribe?.(event => {
        if (!['gateway-memory-api', 'realtime-tool'].includes(event.source)) return
        conversationSync?.discardRecorded?.(event.ownerId)
        preferenceCandidates?.discardPending(event.ownerId)
      })
    : null
  return {
    services: {
      frontendMemory: frontendMemoryRuntime,
      frontendMemoryService: memoryProviderRuntime,
      memoryProvider: memoryProviderRuntime,
      preferenceCandidates, preferencePromoter, profileObserver,
    },
    sessionObservers: [new MemorySessionObserver({
      memoryService: frontendMemoryRuntime, memoryExtractor, preferencePromoter,
      profileObserver, conversationSync,
    })],
    close: () => {
      unsubscribeLearning?.()
      return frontendMemoryRuntime?.close?.()
    },
    mountRoutes(app) {
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
    },
  }
}
