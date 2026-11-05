import { apiProfile, defineProviderModels } from './profile.mjs'

export const DEFAULT_GPT_LIVE_REALTIME_MODEL = 'gpt-realtime-2.1'
export const gptLiveModels = defineProviderModels(DEFAULT_GPT_LIVE_REALTIME_MODEL, {
  'gpt-live': apiProfile('gpt-live', 'server_vad'),
}, {
  [DEFAULT_GPT_LIVE_REALTIME_MODEL]: {
    label: 'GPT Realtime 2.1', api: 'gpt-live', voice: null,
  },
})
