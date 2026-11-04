// Shared CLI projection; configure before creating Gateway sessions.
export function configureAsrReview(args, env = process.env) {
  const mode = String(args.get('asr-review') || env.QWEN_AUDIO_ASR_REVIEW || 'off')
  const delegation = String(args.get('asr-delegation') || env.QWEN_AUDIO_ASR_DELEGATION || 'confirm')
  if (!['off', 'on'].includes(mode)) throw new Error('--asr-review must be off or on')
  if (!['confirm', 'dual-query'].includes(delegation)) throw new Error('--asr-delegation must be confirm or dual-query')
  env.QWEN_AUDIO_ASR_REVIEW = mode
  env.QWEN_AUDIO_ASR_DELEGATION = delegation
  return { enabled: mode === 'on', delegation }
}
