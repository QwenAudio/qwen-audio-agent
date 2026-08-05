const RESPONSE_ACTIVITY_TYPES = new Set([
  'response.created',
  'response.done',
  'response.output_item.added',
  'response.output_item.done',
  'response.content_part.added',
  'response.content_part.done',
  'response.function_call_arguments.delta',
  'response.function_call_arguments.done',
  'response.audio.delta',
  'response.audio.done',
  'response.output_audio.delta',
  'response.output_audio.done',
  'response.audio_transcript.delta',
  'response.audio_transcript.done',
  'response.output_audio_transcript.delta',
  'response.output_audio_transcript.done',
  'response.text.delta',
  'response.text.done',
  'response.output_text.delta',
  'response.output_text.done',
])

export function realtimeResponseId(event) {
  return event?.response_id
    || event?.response?.id
    || event?.item?.response_id
    || ''
}

/**
 * True for a server event that proves a Realtime response exists. A compliant
 * provider emits response.created first, but compatible implementations may
 * emit output activity (or even response.done) without that opening event.
 */
export function isResponseActivityEvent(event) {
  return Boolean(
    realtimeResponseId(event)
    && RESPONSE_ACTIVITY_TYPES.has(event?.type),
  )
}
