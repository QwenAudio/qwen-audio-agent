import { readFileSync } from 'node:fs'
import { buildMemoryContext } from './context.mjs'
import { MEMORY_TOOL_NAME, memoryToolEntries, memoryToolHandlers } from './tools.mjs'

const instructions = readFileSync(new URL('./PROMPT.md', import.meta.url), 'utf8').trim()

export const memoryFrontend = {
  entries: memoryToolEntries,
  handlers: memoryToolHandlers,
  context: buildMemoryContext,
  instructions,
  capabilities: ({ memoryService }) => memoryService ? ['memory'] : [],
  // Keep read/write presentation semantics inside this optional feature. A
  // completed automatic write need not repeat an already-spoken response.
  requiresToolResultSummary: (name, args) => name === MEMORY_TOOL_NAME
    ? String(args?.action || '').trim().toLowerCase() === 'read'
    : undefined,
}
