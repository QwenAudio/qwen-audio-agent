import { asrReviewOptions } from '../../../../server/src/frontend/tools/asr-review.mjs'
// Shared CLI projection; configure before creating Gateway sessions.
export function configureAsrReview(args, env = process.env) {
  const mode = String(args.get('asr-review') || env.QWEN_AUDIO_ASR_REVIEW || 'off')
  const delegation = String(args.get('asr-delegation') || env.QWEN_AUDIO_ASR_DELEGATION || 'confirm')
  if (!['off', 'on'].includes(mode)) throw new Error('--asr-review must be off or on')
  if (!['confirm', 'dual-query'].includes(delegation)) throw new Error('--asr-delegation must be confirm or dual-query')
  env.QWEN_AUDIO_ASR_REVIEW = mode
  env.QWEN_AUDIO_ASR_DELEGATION = delegation
  for (const [flag, key] of [['asr-frontend-review', 'QWEN_AUDIO_ASR_FRONTEND_REVIEW'], ['asr-delegation-review', 'QWEN_AUDIO_ASR_DELEGATION_REVIEW']]) {
    if (args.has(flag)) env[key] = String(args.get(flag))
  }
  return asrReviewOptions(env)
}
