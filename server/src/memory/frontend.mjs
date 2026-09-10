import { readFileSync } from 'node:fs'
import { buildMemoryContext } from './context.mjs'
import { memoryToolEntries, memoryToolHandlers } from './tools.mjs'

const instructions = readFileSync(new URL('./PROMPT.md', import.meta.url), 'utf8').trim()

export const memoryFrontend = {
  entries: memoryToolEntries,
  handlers: memoryToolHandlers,
  context: buildMemoryContext,
  instructions,
  capabilities: ({ memoryService }) => memoryService ? ['memory'] : [],
}
