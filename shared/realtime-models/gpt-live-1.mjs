import { apiProfile, defineProviderModels } from './profile.mjs'

export const DEFAULT_GPT_LIVE_1_REALTIME_MODEL = 'gpt-live-1'
export const gptLive1Models = defineProviderModels(DEFAULT_GPT_LIVE_1_REALTIME_MODEL, {
  // Full duplex has no turn detection; tools use Responses delegation.
  'gpt-live-1': apiProfile('gpt-live-1', null),
}, {
  [DEFAULT_GPT_LIVE_1_REALTIME_MODEL]: {
    label: 'GPT-Live 1', api: 'gpt-live-1', voice: null,
  },
})
