// Reusable integration presets for model families using the same wire variant.
// Model capabilities are shared defaults, not capabilities inferred from an ID.
// Transport capabilities and constraints describe the implemented adapter path;
// selecting a preset does not implement a new protocol or enable missing I/O.
const AUDIO_MODEL_CAPABILITIES = Object.freeze({
  textInput: true, audioInput: true, imageInput: false, videoInput: false,
  textOutput: true, audioOutput: true, functionCalling: true,
})
const AUDIO_TRANSPORT_CAPABILITIES = Object.freeze({
  textInput: true, audioInput: true, imageInput: false, imageBufferInput: false,
})
const OMNI_MODEL_CAPABILITIES = Object.freeze({
  textInput: true, audioInput: true, imageInput: true, videoInput: true,
  textOutput: true, audioOutput: true, functionCalling: true,
})
const OMNI_TRANSPORT_CAPABILITIES = Object.freeze({
  textInput: true, audioInput: true, imageInput: false, imageBufferInput: true,
})
const NO_SESSION_CONSTRAINTS = Object.freeze({})

function apiProfile(family, turnDetection, {
  visual = false,
  sessionConstraints = NO_SESSION_CONSTRAINTS,
} = {}) {
  return Object.freeze({
    family,
    turnDetection: turnDetection ? Object.freeze({ type: turnDetection }) : null,
    defaultModelCapabilities: visual ? OMNI_MODEL_CAPABILITIES : AUDIO_MODEL_CAPABILITIES,
    transportCapabilities: visual ? OMNI_TRANSPORT_CAPABILITIES : AUDIO_TRANSPORT_CAPABILITIES,
    sessionConstraints,
  })
}

export const REALTIME_API_PROFILES = Object.freeze({
  dashscope: Object.freeze({
    audio: apiProfile('audio', 'smart_turn'),
    omni: apiProfile('omni', 'semantic_vad', {
      visual: true,
      sessionConstraints: Object.freeze({ unsupportedVoices: Object.freeze(['Cherry']) }),
    }),
    'omni-v2': apiProfile('omni', 'semantic_vad', {
      visual: true,
      sessionConstraints: Object.freeze({ workspaceEndpoint: true }),
    }),
  }),
  stepfun: Object.freeze({
    stepfun: apiProfile('stepaudio', 'server_vad'),
  }),
  'gpt-live': Object.freeze({
    'gpt-live': apiProfile('gpt-live', 'server_vad'),
  }),
  // Full duplex with no turn-detection settings; tools go through Responses delegation.
  'gpt-live-1': Object.freeze({
    'gpt-live-1': apiProfile('gpt-live-1', null),
  }),
  'google-live': Object.freeze({
    'google-live': apiProfile('google-live', 'server_vad', { visual: true }),
  }),
  'doubao-seeduplex': Object.freeze({
    'doubao-seeduplex': apiProfile('doubao-seeduplex', 'server_vad'),
  }),
})
