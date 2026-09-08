import {
  BACKEND_INPUT_RESPONSE_CAPABILITY,
  PERMISSION_RESPONSE_CAPABILITY,
  SPAWN_THINKING_TOOL_NAME,
} from './features/agent-task-tools.mjs'
import { FRONTEND_RECALL_CAPABILITY } from './features/retrieval-tools.mjs'

// Use the same availability projection for model schemas and tool dispatch.
// Only an explicitly unconfigured backend removes execution; a temporarily
// disconnected backend keeps its tool and reports its current error at runtime.
export function buildFrontendToolContext({
  disabledTools = [],
  backendAvailability = null,
  frontendRetrieval = null,
  frontendKnowledge = null,
  sessionDigests = null,
  permissionPending = false,
  inputPending = false,
} = {}) {
  const backendConfigured = backendAvailability?.snapshot()?.configured !== false
  return {
    backendConfigured,
    disabledTools: [...new Set([
      ...disabledTools,
      ...(!backendConfigured ? [SPAWN_THINKING_TOOL_NAME] : []),
    ])],
    capabilities: [...new Set([
      ...(frontendRetrieval?.capabilities?.() || []),
      ...(frontendKnowledge?.capabilities?.() || []),
      ...(sessionDigests ? [FRONTEND_RECALL_CAPABILITY] : []),
      ...(permissionPending ? [PERMISSION_RESPONSE_CAPABILITY] : []),
      ...(inputPending ? [BACKEND_INPUT_RESPONSE_CAPABILITY] : []),
    ])],
  }
}
