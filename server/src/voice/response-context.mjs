function pendingTranscripts(value) {
  return Array.isArray(value) ? value : []
}

const CORRELATED_CONTEXT_FIELDS = [
  'turnId',
  'taskId',
  'taskIds',
  'turnIds',
  'authorizationId',
  'turnGeneration',
  'deliverySequence',
  'consumesTaskNotification',
]

/**
 * Build the authoritative part of a response context from one provider event.
 *
 * Realtime providers commonly attach correlation metadata only to
 * response.created/response.done, not to every audio or transcript delta.
 * Missing metadata on a later delta must therefore preserve the context that
 * was already correlated instead of resetting it to the ordinary model turn.
 */
export function responseActivityContextPatch({
  existing,
  event,
  fallback,
}) {
  const patch = existing ? {} : { ...fallback }
  const correlated = event?.__voiceContext
  if (correlated && typeof correlated === 'object') {
    for (const field of CORRELATED_CONTEXT_FIELDS) {
      if (Object.hasOwn(correlated, field)) patch[field] = correlated[field]
    }
  }
  if (typeof event?.__voiceOrigin === 'string' && event.__voiceOrigin) {
    patch.origin = event.__voiceOrigin
  }
  return patch
}

export function ensureResponseContext(contexts, id, fallback = {}) {
  const existing = contexts.get(id)
  if (existing) {
    existing.pendingTranscripts = pendingTranscripts(existing.pendingTranscripts)
    return existing
  }

  const context = {
    turnId: '',
    taskId: null,
    origin: 'model',
    turnGeneration: -1,
    playbackStarted: false,
    playbackEnded: false,
    responseDone: false,
    transcriptDone: false,
    ...fallback,
    pendingTranscripts: pendingTranscripts(fallback.pendingTranscripts),
  }
  contexts.set(id, context)
  return context
}

export function mergeResponseContext(contexts, id, authoritative = {}) {
  const existing = ensureResponseContext(contexts, id)
  const context = {
    ...existing,
    ...authoritative,
    playbackStarted: existing.playbackStarted,
    playbackEnded: existing.playbackEnded,
    responseDone: existing.responseDone,
    transcriptDone: existing.transcriptDone,
    pendingTranscripts: existing.pendingTranscripts,
  }
  contexts.set(id, context)
  return context
}
