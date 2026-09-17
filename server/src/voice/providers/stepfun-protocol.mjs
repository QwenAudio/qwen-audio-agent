import { openAiCompatibleProtocol } from './openai-compatible-protocol.mjs'

// StepFun documents session instructions and conversation items, but not the
// beta response-level instructions/tool_choice/conversation extensions.
// Keep that difference at the wire boundary, including Gateway announcements.
export function createStepFunProtocol() {
  let activeResponseId = ''
  return {
    ...openAiCompatibleProtocol,

    responseInstructionsItem: response => response?.instructions
      ? openAiCompatibleProtocol.userTextItem(response.instructions)
      : null,

    responseCreate: response => ({
      type: 'response.create',
      ...(response?.modalities ? { response: { modalities: response.modalities } } : {}),
    }),

    normalizeIncoming(event) {
      if (event.type === 'response.created') activeResponseId = event.response?.id || ''
      const responseId = event.response_id || event.response?.id || activeResponseId
      if (event.type === 'response.thinking.delta' || event.type === 'response.thinking.done') {
        // Only retain liveness; thinking text is not presentation content.
        return { type: 'response.activity', response_id: responseId }
      }
      if (event.type === 'response.cancelled') {
        if (!responseId) return null
        if (responseId === activeResponseId) activeResponseId = ''
        return {
          type: 'response.done',
          response: { ...event.response, id: responseId, status: 'cancelled' },
        }
      }
      // Some documented function/audio deltas omit response_id. This dialect
      // has one active response, so retain its identity for tool batching.
      const normalized = event.type.startsWith('response.') && responseId
        ? { ...event, response_id: responseId }
        : event
      if (event.type === 'response.done' && responseId === activeResponseId) activeResponseId = ''
      return normalized
    },
  }
}
