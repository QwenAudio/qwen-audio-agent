import { apiProfile, defineProviderModels } from './profile.mjs'

export const DEFAULT_GOOGLE_LIVE_REALTIME_MODEL = 'gemini-3.8-live'
export const googleLiveModels = defineProviderModels(DEFAULT_GOOGLE_LIVE_REALTIME_MODEL, {
  'google-live': apiProfile('google-live', 'server_vad', { visual: true }),
}, {
  [DEFAULT_GOOGLE_LIVE_REALTIME_MODEL]: {
    label: 'Gemini 3.8 Live', api: 'google-live', voice: null,
  },
})
