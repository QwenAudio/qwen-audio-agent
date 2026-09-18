// Shared by the example host and UI. Model IO support does not imply tool
// calling or compatibility with the separate, provider-specific visual reader.
export function visualFeatures({ provider, modelProfile } = {}) {
  const model = modelProfile?.modelCapabilities || {}
  const transport = modelProfile?.transportCapabilities || {}
  const readerAvailable = provider === 'dashscope' && modelProfile?.family === 'omni'
  return {
    continuous: transport.imageBufferInput === true,
    textInput: transport.textInput === true,
    visualTools: readerAvailable && model.functionCalling === true,
  }
}
