import { MarkdownContextStore } from './providers/markdown/context-store.mjs'
import { MarkdownMemoryProvider } from './providers/markdown/provider.mjs'
import {
  VoiceMemProvider,
} from './providers/voicemem/provider.mjs'

function createMarkdownProvider({ config, logger }) {
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
  return new MarkdownMemoryProvider({
    userStore: userDocuments,
    memoryStore: memoryDocuments,
  })
}

export function createConfiguredMemoryProvider({
  config,
  logger,
  env = process.env,
} = {}) {
  const selected = config?.memoryProvider || 'markdown'
  if (selected === 'voicemem') {
    return new VoiceMemProvider({
      stateDirectory: config.voiceMemStateDirectory,
      python: config.voiceMemPython || null,
      sidecarPath: config.voiceMemSidecarPath || null,
      env,
    })
  }
  if (selected === 'markdown') {
    return createMarkdownProvider({ config, logger })
  }
  throw new Error(`不支持的记忆 Provider：${selected}`)
}
