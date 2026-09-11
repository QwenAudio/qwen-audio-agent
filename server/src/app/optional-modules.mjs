import { createMemoryModule } from '../memory/module.mjs'
import { createKnowledgeModule } from '../knowledge/module.mjs'

// Explicit composition keeps optional features removable without teaching
// the Gateway how their stores, learners, providers or HTTP routes work.
export const optionalModuleFactories = [createMemoryModule, createKnowledgeModule]
