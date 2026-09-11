import { knowledgeToolEntries, knowledgeToolHandlers } from './tools.mjs'

export const knowledgeFrontend = {
  entries: knowledgeToolEntries,
  handlers: knowledgeToolHandlers,
  capabilities: ({ frontendKnowledge }) => frontendKnowledge?.capabilities?.() || [],
}
