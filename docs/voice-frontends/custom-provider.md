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
- `conversationItemCreate(item, { contextOnly })` distinguishes context delivery from interactive user input. For message items, `contextOnly: true` must write context without triggering a reply; it must not merely cache the text for a later `responseCreate`. Gateway passes `false` for interactive text/file input. Tool receipts keep the provider's native continuation semantics.
- Set `automaticToolResponses: true` only when tool results natively resume generation (Doubao Seeduplex and Google Live). Runtime sends these receipts without waiting for response completion, and the tool-batch follow-up uses `ensureResponse(..., { afterToolResults: true })` without requesting a second reply. `sendFunctionOutput` acknowledges delivery with `{ delivered: true, automatic: true }`; this is not speech completion. `createResponse: false` cannot disable the service's native continuation, nor can per-response instructions control it. Other providers keep explicit response creation and completion tracking.
- Normalize events that only prove liveness to `response.activity` with a `response_id`, without forwarding thinking text.
- Set `conversationItemIdEcho: false` when the service assigns new IDs to acknowledged conversation items. Gateway correlates the single pending item without delays or skipping acknowledgment.
- Set `imageRequiresAudioStart: true` only if the service requires audio before the first video frame. Gateway primes that timeline with 20 ms of PCM16 silence so camera input does not require opening the microphone.
- Set `acknowledgesConversationItems: false` when the service accepts input or tool-response messages without sending a conversation-item acknowledgment. Gateway resolves the send after writing the frame.
- Set `restoreConversationContext: false` when injected history would be interpreted as live user input instead of passive context.
- `visibility: 'gateway-only'` lets the host select a Provider without exposing it in desktop settings or the public Provider list.

A Provider must implement the full contract — `model()`, `voice()`, `isConfigured()`, `url()`, `headers()`, `classifyError()`, `buildSession()`, `buildSpeakResponse()`, `buildResultInjection()`, `buildPermissionInjection()` — plus numeric `inputSampleRate` and `outputSampleRate` fields; registration throws on any missing member.

Provider and Protocol contracts are validated during registration and connection setup, so missing methods or invalid values fail immediately.

## Behavior verification

Run `node --test server/test/realtime-provider-behavior.test.mjs` from the repository root. The same suite exercises every built-in Provider through the real session runtime and a local WebSocket service: context-only updates, tool continuation, permissions, cancellation, queued asynchronous replies, and reconnect/context restoration. Unsupported features must return an explicit unsupported result or error; the suite does not treat them as successful delivery.

The fixtures implement native wire behavior rather than calling the adapters to construct mock replies. When adding a dialect, add its fixture and run the shared suite. This is deterministic contract coverage, not a substitute for live service validation or audio/device testing.

`server/test/native-tool-continuation.test.mjs` additionally covers MCP result normalization through `ToolCallHandler` to a local native-protocol service, including failures, transport errors, and mixed results. In [Doubao Seeduplex](https://docs.volcengine.com/docs/DoubaoVoice/endtoend-realtime-voice-full-duplex-version?lang=zh), function calls can precede `response.done`; the service waits for the matching tool results before completing the interaction. Tests must preserve that ordering rather than inventing an earlier terminal event.

For [Google Live](https://ai.google.dev/api/live), context-only history uses `clientContent` with `turnComplete: false`; committing the turn starts a reply. Unlike passive history insertion in some protocols, Google documents that `clientContent` also interrupts active generation. Queued context waits for idle, while an immediate permission/context delivery can interrupt. Tool responses resume generation natively, and `generationComplete` does not release the response slot until `turnComplete` arrives.

## Desktop settings

Built-in frontend settings live in `shared/realtime-provider-definitions.mjs`, a browser-safe catalog without credentials or connection implementations. Declare a provider's name, fields, environment mappings, and defaults there; maintain `shared/realtime-model-catalog.mjs` when selectable models are available. The desktop chooser, form, configuration persistence, and status labels consume these definitions without provider-specific HTML panels.

The form always displays Service URL, API Key, Model, and Voice, mapped to the `endpoint`, `credential`, `model`, and `voice` slots. Providers bind only configurable slots; unbound rows remain visible but disabled and are never persisted. Bearer tokens use the API Key row while keeping their original configuration keys. Use `activeDefault` for suggested self-hosted endpoints on selection and `modelFamily` for independent voice overrides. Existing configuration keys and aliases are preserved; inactive endpoint drafts cannot block applying the selected provider. A remote Gateway continues to own its frontend configuration.

Settings metadata is separate from runtime adapters. Host-injected custom Providers are not automatically registered in the desktop chooser.
