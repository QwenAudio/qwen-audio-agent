// This is a standalone asset loaded by audioWorklet.addModule(), not a bundled
// application module. Keep it import-free so Vite may safely inline its URL.

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
