import { apiProfile, defineProviderModels } from './profile.mjs'

export const DEFAULT_STEPFUN_REALTIME_MODEL = 'stepaudio-3-realtime-preview'
export const stepfunModels = defineProviderModels(DEFAULT_STEPFUN_REALTIME_MODEL, {
  stepfun: apiProfile('stepaudio', 'server_vad'),
}, {
  [DEFAULT_STEPFUN_REALTIME_MODEL]: {
    label: 'StepAudio 3 Realtime Preview', api: 'stepfun', voice: null,
  },
})
