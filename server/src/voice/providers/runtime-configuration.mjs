import { config } from '../../core/config.mjs'
import { realtimeModelCatalog } from '../../../../shared/realtime-model-catalog.mjs'
import { REALTIME_PROVIDERS } from '../../../../shared/realtime-provider-definitions.mjs'

// Only the selected adapter owns connection settings. Inactive adapters expose
// catalog defaults for registry validation, never another provider's credentials.
export function providerRuntimeConfiguration(key) {
  const definition = REALTIME_PROVIDERS.find(provider => provider.key === key)
  const active = () => config.audioProvider === key
  return {
    get model() {
      return active() ? config.realtimeModel
        : realtimeModelCatalog(key, config.realtimeModelCatalogs)?.defaultModel || null
    },
    get voice() { return active() ? config.realtimeVoice : null },
    get endpoint() { return active() ? config.realtimeEndpoint : '' },
    get credential() { return active() ? config.realtimeCredential : '' },
    get configured() {
      return active() && Boolean(definition.requiredConfiguration.field === 'realtimeUrl'
        ? this.endpoint : this.credential)
    },
  }
}
