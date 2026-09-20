# Extending Realtime Providers

A Realtime Provider adapts a realtime model service to the runtime; it is neither the client nor the Orchestration Runtime itself. A product host can inject a custom provider without changing shared session or backend-work logic. The example below assembles it through the Gateway application entry point.

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
- Optional synchronous `validateSessionOptions({ sessionOptions })` runs before opening the
  upstream connection. Only reject known-invalid selections; leave unknown values to the service.
- `connectionMessages()` emits raw handshake frames after the WebSocket opens and before `session.update`.
- All later events pass through `encodeOutgoing()` and `normalizeIncoming()`, leaving Gateway tools, tasks, and client protocols unchanged.
- Protocols without transient response instructions can implement `responseInstructionsItem(response)`. Gateway creates and awaits that conversation item before calling `responseCreate(response)`, which strips unsupported wire parameters. Set `perResponseInstructions: false`; these instructions remain in history.
- Normalize events that only prove liveness to `response.activity` with a `response_id`, without forwarding thinking text.
- Set `conversationItemIdEcho: false` when the service assigns new IDs to acknowledged conversation items. Gateway correlates the single pending item without delays or skipping acknowledgment.
- Set `acknowledgesConversationItems: false` when the service accepts input or tool-response messages without sending a conversation-item acknowledgment. Gateway resolves the send after writing the frame.
- Set `restoreConversationContext: false` when injected history would be interpreted as live user input instead of passive context.
- `visibility: 'gateway-only'` lets the host select a Provider without exposing it in desktop settings or the public Provider list.

A Provider must implement the full contract — `model()`, `voice()`, `isConfigured()`, `url()`, `headers()`, `classifyError()`, `buildSession()`, `buildSpeakResponse()`, `buildResultInjection()`, `buildPermissionInjection()` — plus numeric `inputSampleRate` and `outputSampleRate` fields; registration throws on any missing member.

Provider and Protocol contracts are validated during registration and connection setup, so missing methods or invalid values fail immediately.

## Desktop settings

Built-in frontend settings live in `shared/realtime-provider-definitions.mjs`, a browser-safe catalog without credentials or connection implementations. Declare a provider's name, fields, environment mappings, and defaults there; maintain `shared/realtime-model-catalog.mjs` when selectable models are available. The desktop chooser, form, configuration persistence, and status labels consume these definitions without provider-specific HTML panels.

The form always displays Service URL, API Key, Model, and Voice, mapped to the `endpoint`, `credential`, `model`, and `voice` slots. Providers bind only configurable slots; unbound rows remain visible but disabled and are never persisted. Bearer tokens use the API Key row while keeping their original configuration keys. Use `activeDefault` for suggested self-hosted endpoints on selection and `modelFamily` for independent voice overrides. Existing configuration keys and aliases are preserved; inactive endpoint drafts cannot block applying the selected provider. A remote Gateway continues to own its frontend configuration.

Settings metadata is separate from runtime adapters. Host-injected custom Providers are not automatically registered in the desktop chooser.
