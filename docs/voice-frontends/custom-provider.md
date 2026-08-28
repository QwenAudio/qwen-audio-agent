# Extending Realtime Providers

A product host can inject a custom Realtime Provider without changing the Gateway voice session or backend Agent logic.

```js
import { createGatewayApplication } from 'qwen-audio-agent/gateway-application'
import {
  createRealtimeProviderRegistry,
} from 'qwen-audio-agent/realtime-provider'
import { privateRealtimeProvider } from './private-realtime-provider.mjs'

const realtimeProviderRegistry = createRealtimeProviderRegistry({
  providers: [privateRealtimeProvider],
  defaultProvider: privateRealtimeProvider.key,
})

createGatewayApplication({
  realtimeProviderRegistry,
  realtimeProvider: privateRealtimeProvider.key,
})
```

The extension boundary is:

- Each Provider is an independent adapter that owns its URL, authentication, model, session, and error-classification semantics. Product differences should not be carried by reshaping another Provider.
- `url()`, `headers()`, and `model()` can read the service URL, token, and model from host-owned configuration closures. The Gateway does not require product-specific environment variables.
- `createProtocol()` runs once for each Realtime connection, so connection IDs and mutable state remain isolated.
- `connectionMessages()` emits raw handshake frames after the WebSocket opens and before `session.update`.
- All later events pass through `encodeOutgoing()` and `normalizeIncoming()`, leaving Gateway tools, tasks, and client protocols unchanged.
- `visibility: 'gateway-only'` lets the host select a Provider without exposing it in desktop settings or the public Provider list.

A Provider must implement the full contract — `model()`, `voice()`, `isConfigured()`, `url()`, `headers()`, `classifyError()`, `buildSession()`, `buildSpeakResponse()`, `buildResultInjection()`, `buildPermissionInjection()` — plus numeric `inputSampleRate` and `outputSampleRate` fields; registration throws on any missing member.

Provider and Protocol contracts are validated during registration and connection setup, so missing methods or invalid values fail immediately.
