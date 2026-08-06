// The one place that decides whether flow analysis happens, and whether it
// survives a restart.
//
// Every instrumented site imports `flowRecorder` and calls it unconditionally.
// When the feature is off this is the null recorder, so no call site needs a
// flag check and no behaviour changes. Keeping the decision here also means the
// switches are read once, at startup, rather than consulted on every event.
import { resolve } from 'node:path'

import { config } from '../core/config.mjs'
import { logger } from '../core/logger.mjs'
import { FlowRecorder, NULL_FLOW_RECORDER } from './flow-recorder.mjs'
import { createFlowStore } from './flow-store.mjs'

export const flowTraceEnabled = Boolean(config.flowTrace)

// Persistence is its own switch: analysis in memory leaves nothing behind, and
// that is the default someone gets by simply turning analysis on.
export const flowTraceFileEnabled = flowTraceEnabled && Boolean(config.flowTraceFile)

export const flowTraceDirectory = resolve(config.configDirectory, 'flow')

export const flowRecorder = flowTraceEnabled
  ? new FlowRecorder()
  : NULL_FLOW_RECORDER

export const flowStore = flowTraceFileEnabled
  ? createFlowStore({
    directory: flowTraceDirectory,
    retentionDays: config.flowTraceRetentionDays,
    onWarning: warning => logger.warn('flow.persistence_warning', { warning }),
  })
  : null

// Called once at startup. Reading history back is what makes a restart survivable
// -- otherwise the trace of the interaction someone was about to look at is gone
// exactly when they go to look at it.
export async function startFlowPersistence() {
  if (!flowStore) return
  flowRecorder.subscribe(event => flowStore.append(event))
  const restored = await flowStore.loadRecent({
    maxFlows: flowRecorder.maxFlows,
    maxEventsPerFlow: flowRecorder.maxEventsPerFlow,
  })
  flowRecorder.restore(restored)
  const removed = await flowStore.prune()
  logger.info('flow.persistence_ready', {
    directory: flowTraceDirectory,
    restoredEvents: restored.length,
    prunedFiles: removed,
    retentionDays: config.flowTraceRetentionDays,
  })
}

// A flow is one user interaction. turnId already identifies exactly that and
// already appears in the logs, so deriving from it keeps a single vocabulary
// instead of introducing a second set of ids nobody can cross-reference.
export function flowIdForTurn(turnId, sessionId = '') {
  const turn = typeof turnId === 'string' ? turnId.trim() : ''
  if (turn) return turn
  const session = typeof sessionId === 'string' ? sessionId.trim() : ''
  return session ? `session-${session}` : ''
}
