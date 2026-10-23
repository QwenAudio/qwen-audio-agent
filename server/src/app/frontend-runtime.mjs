import { config as defaultConfig } from '../core/config.mjs'
import { logger as defaultLogger } from '../core/logger.mjs'
import { conversationSync as defaultConversationSync } from '../conversation/conversation-sync.mjs'
import { TaskManager } from '../task/task-manager.mjs'
import { InputAssetRegistry } from '../voice/input-asset-registry.mjs'
import { SessionObservers } from '../voice/session-observers.mjs'
import { defaultRealtimeProviderRegistry } from '../voice/realtime-provider.mjs'
import { createRealtimeSessionRuntime } from '../voice/realtime-session-runtime.mjs'
import { createTaskAnnouncementRuntime } from '../voice/announcement/task-announcement-runtime.mjs'

/** Application wiring shared by every transport; each connection owns a session. */
export function createFrontendRuntime({
  config = defaultConfig,
  logger = defaultLogger,
  sessionObservers = [],
  taskManager = new TaskManager(),
  inputAssets = new InputAssetRegistry(),
  conversationSync = defaultConversationSync,
  realtimeProviderRegistry = defaultRealtimeProviderRegistry,
  defaultRealtimeProvider = config.audioProvider,
  taskAnnouncementFactory = createTaskAnnouncementRuntime,
  frontendToolSources = [],
  memoryService, sessionDigests = null, notesStore,
  taskOperations, backendRuntime, backendAvailability = null,
  respondAuthorization, respondInput, permissionPolicy,
  realtimeFrontendFactory,
  frontendRetrieval = null, frontendKnowledge = null,
  spawnThinkingDescription = '',
} = {}) {
  const observers = new SessionObservers(sessionObservers)
  const sessions = new Set()
  let closed = false
  // Discovery belongs to application startup, not to a socket or handshake.
  // Share one initialization across sessions; clients can connect while it runs.
  const frontendToolSourcesReady = Promise.all(
    frontendToolSources.map(source => Promise.resolve().then(() => source.initialize())),
  ).catch(error => logger.warn('frontend_tools.initialization_failed', {
    error: error.message,
  }))
  const dependencies = {
    config, taskManager, inputAssets, conversationSync, realtimeProviderRegistry,
    defaultRealtimeProvider, taskAnnouncementFactory, frontendToolSources,
    frontendToolSourcesReady, observers, memoryService, sessionDigests, notesStore,
    taskOperations, backendRuntime, backendAvailability,
    respondAuthorization, respondInput, permissionPolicy, realtimeFrontendFactory,
    frontendRetrieval, frontendKnowledge, spawnThinkingDescription,
  }

  return {
    createSession(options) {
      if (closed) throw new Error('Frontend runtime is closed')
      const session = createRealtimeSessionRuntime({ ...dependencies, logger, ...options })
      const closeSession = session.close
      session.close = () => {
        sessions.delete(session)
        closeSession()
      }
      sessions.add(session)
      return session
    },
    supportsImageInput(providerName) {
      try {
        return realtimeProviderRegistry.resolve(providerName || defaultRealtimeProvider)
          .modelProfile?.()?.transportCapabilities?.imageBufferInput === true
      } catch {
        return false
      }
    },
    async close() {
      closed = true
      for (const session of sessions) session.close()
      await observers.drain()
      // Tool sources are application services; their owner closes them after
      // all frontend sessions and observers have finished.
    },
  }
}
