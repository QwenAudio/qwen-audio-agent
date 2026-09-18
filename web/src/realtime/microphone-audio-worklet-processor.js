// This standalone, import-free asset is loaded by audioWorklet.addModule().
// Emit it as a same-origin script so the desktop's strict CSP allows it.

class MicrophoneAudioWorkletProcessor extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const input = inputs[0]?.[0]
    if (input?.length) {
      const samples = new Float32Array(input)
      this.port.postMessage({
        type: 'samples',
        samples: samples.buffer,
      }, [samples.buffer])
    }

    // Keep the graph alive without routing microphone audio back to speakers.
    for (const channel of outputs[0] || []) channel.fill(0)
    return true
  }
}

registerProcessor(
  'qwen-audio-microphone',
  MicrophoneAudioWorkletProcessor,
)
