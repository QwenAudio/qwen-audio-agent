const DEFAULT_MAX_CALLS_PER_TURN = 12
const DEFAULT_MAX_DURATION_MS = 30_000
const DEFAULT_MAX_TRACKED_TURNS = 100
export const DEFAULT_FRONTEND_TOOL_MAX_RESULT_BYTES = 64 * 1024

function positiveInteger(value, fallback) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : fallback
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, stableValue(value[key])]),
  )
}

function callSignature(toolName, args) {
  return `${toolName}:${JSON.stringify(stableValue(args))}`
}

export function boundFrontendToolResult(
  value,
  maxBytes = DEFAULT_FRONTEND_TOOL_MAX_RESULT_BYTES,
) {
  const limit = positiveInteger(
    maxBytes,
    DEFAULT_FRONTEND_TOOL_MAX_RESULT_BYTES,
  )
  try {
    const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8')
    return bytes <= limit
      ? { accepted: true, value, bytes, maxBytes: limit }
      : { accepted: false, value: undefined, bytes, maxBytes: limit }
  } catch {
    return {
      accepted: false,
      value: undefined,
      bytes: null,
      maxBytes: limit,
    }
  }
}

/**
 * Per-connection safety boundary for model-driven frontend tool loops.
 *
 * The guard is deliberately independent from tool behavior: it limits one
 * correlated user turn by time and call count, and blocks an exact repeated
 * call before a side effect can run. A new turn receives a fresh budget.
 */
export class FrontendToolLoop {
  #maxCallsPerTurn
  #maxDurationMs
  #maxTrackedTurns
  #now
  #turns = new Map()

  constructor({
    maxCallsPerTurn = DEFAULT_MAX_CALLS_PER_TURN,
    maxDurationMs = DEFAULT_MAX_DURATION_MS,
    maxTrackedTurns = DEFAULT_MAX_TRACKED_TURNS,
    now = Date.now,
  } = {}) {
    this.#maxCallsPerTurn = positiveInteger(
      maxCallsPerTurn,
      DEFAULT_MAX_CALLS_PER_TURN,
    )
    this.#maxDurationMs = positiveInteger(
      maxDurationMs,
      DEFAULT_MAX_DURATION_MS,
    )
    this.#maxTrackedTurns = positiveInteger(
      maxTrackedTurns,
      DEFAULT_MAX_TRACKED_TURNS,
    )
    this.#now = typeof now === 'function' ? now : Date.now
  }

  admit({ turnId, turnGeneration, tool, args = {} } = {}) {
    const id = String(turnId || '').trim()
    const name = String(tool?.name || '').trim()
    if (!id || !name) return { admitted: true, reason: null }

    const key = `${String(turnGeneration ?? '')}:${id}`
    const now = this.#now()
    let turn = this.#turns.get(key)
    if (!turn) {
      turn = {
        startedAt: now,
        calls: 0,
        callsByTool: new Map(),
        signatures: new Set(),
      }
      if (this.#turns.size >= this.#maxTrackedTurns) {
        this.#turns.delete(this.#turns.keys().next().value)
      }
      this.#turns.set(key, turn)
    }

    if (now - turn.startedAt > this.#maxDurationMs) {
      return {
        admitted: false,
        reason: 'duration_limit',
        calls: turn.calls,
      }
    }
    if (turn.calls >= this.#maxCallsPerTurn) {
      return {
        admitted: false,
        reason: 'call_limit',
        calls: turn.calls,
      }
    }
    const toolLimit = positiveInteger(tool?.policy?.maxCallsPerTurn, null)
    const toolCalls = turn.callsByTool.get(name) || 0
    if (toolLimit !== null && toolCalls >= toolLimit) {
      return {
        admitted: false,
        reason: 'tool_call_limit',
        calls: turn.calls,
        toolCalls,
      }
    }

    const signature = callSignature(name, args)
    if (
      turn.signatures.has(signature)
      && tool.policy?.repeatHandling !== 'handler'
    ) {
      return {
        admitted: false,
        reason: 'repeated_call',
        calls: turn.calls,
      }
    }

    turn.calls += 1
    turn.callsByTool.set(name, toolCalls + 1)
    turn.signatures.add(signature)
    return { admitted: true, reason: null, calls: turn.calls }
  }
}
