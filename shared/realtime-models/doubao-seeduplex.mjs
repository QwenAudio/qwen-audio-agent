import { apiProfile, defineProviderModels } from './profile.mjs'

export const DEFAULT_DOUBAO_SEEDUPLEX_REALTIME_MODEL = '1.2.6.1'
export const DEFAULT_DOUBAO_SEEDUPLEX_REALTIME_VOICE = 'zh_female_vv_jupiter_bigtts'
export const doubaoSeeduplexModels = defineProviderModels(DEFAULT_DOUBAO_SEEDUPLEX_REALTIME_MODEL, {
  'doubao-seeduplex': apiProfile('doubao-seeduplex', 'server_vad'),
}, {
  [DEFAULT_DOUBAO_SEEDUPLEX_REALTIME_MODEL]: {
    label: 'Doubao Seeduplex 3.0 Realtime', api: 'doubao-seeduplex',
    voice: DEFAULT_DOUBAO_SEEDUPLEX_REALTIME_VOICE,
  },
})
