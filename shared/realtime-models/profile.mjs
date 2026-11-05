// Browser-safe helpers for code-owned provider metadata. No configuration I/O.
const AUDIO_MODEL_CAPABILITIES = Object.freeze({
  textInput: true, audioInput: true, imageInput: false, videoInput: false,
  textOutput: true, audioOutput: true, functionCalling: true,
})
const AUDIO_TRANSPORT_CAPABILITIES = Object.freeze({
  textInput: true, audioInput: true, imageInput: false, imageBufferInput: false,
})
const OMNI_MODEL_CAPABILITIES = Object.freeze({
  ...AUDIO_MODEL_CAPABILITIES, imageInput: true, videoInput: true,
})
const OMNI_TRANSPORT_CAPABILITIES = Object.freeze({
  ...AUDIO_TRANSPORT_CAPABILITIES, imageBufferInput: true,
})

export function apiProfile(family, turnDetection, { visual = false, sessionConstraints = {} } = {}) {
  return Object.freeze({
    family,
    turnDetection: Object.freeze({ type: turnDetection }),
    defaultModelCapabilities: visual ? OMNI_MODEL_CAPABILITIES : AUDIO_MODEL_CAPABILITIES,
    transportCapabilities: visual ? OMNI_TRANSPORT_CAPABILITIES : AUDIO_TRANSPORT_CAPABILITIES,
    sessionConstraints: Object.freeze(sessionConstraints),
  })
}

export function defineProviderModels(defaultModel, apis, models) {
  return Object.freeze({
    environment: 'QWEN_AUDIO_REALTIME_MODEL',
    defaultModel,
    apis: Object.freeze(apis),
    models: Object.freeze(Object.fromEntries(
      Object.entries(models).map(([id, model]) => [id, Object.freeze(model)]),
    )),
  })
}
