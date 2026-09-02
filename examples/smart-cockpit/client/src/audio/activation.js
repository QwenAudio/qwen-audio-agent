export function activateAudioContext({ current, AudioContextClass } = {}) {
  if (!AudioContextClass) {
    throw new Error('当前浏览器不支持实时语音播放')
  }

  const context = current?.state === 'closed'
    ? new AudioContextClass()
    : current || new AudioContextClass()
  // `resume()` must be called synchronously from the user's click stack.
  // Deferring it to a React effect loses browser user activation and can leave
  // the promise pending forever, while the UI misleadingly appears unmuted.
  const resumed = context.state === 'running'
    ? Promise.resolve()
    : context.resume()

  return {
    context,
    ready: Promise.resolve(resumed).then(() => {
      if (context.state !== 'running') {
        throw new Error('浏览器未允许启用语音，请再次点击麦克风')
      }
      return context
    }),
  }
}
