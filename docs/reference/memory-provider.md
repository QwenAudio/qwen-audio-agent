# Memory Provider and Context Boundaries

The voice frontend composes four context layers. The first two define the assistant;
the last two describe the current user and can be supplied by a replaceable memory
provider.

| Layer | Source | Responsibility |
| --- | --- | --- |
| Core policy | `config/frontend-agent/PROMPT.md` | Tool protocol, permission, safety, and task boundaries; user memory cannot override it |
| Assistant profile | `ASSISTANT.md` | Instance-wide default identity, personality, relationship stance, and expression style; configured by users or downstream products |
| User preferences | `user` (default provider: `USER.md`) | Explicit long-term personalization for the current user; overrides the default persona |
| Long-term memory | `memory` (default provider: `MEMORY.md`) | Durable facts and decisions used to understand the user and answer questions; no behavioral authority |

Instruction conflicts resolve in this order: core policy, the user's current explicit request,
the user preferences, then the assistant profile. Long-term memory is not part of the instruction
hierarchy; it is evidence only, and the user's current statement wins when facts conflict.
Saying “keep replies shorter from now on” or “call yourself Skiff from now on” updates the
current user's `USER.md`, not instance-wide `ASSISTANT.md`; a temporary request applies only to
the current turn.

## The `memory` tool

The frontend exposes one provider-independent `memory` tool, with one atomic operation per call:

- `read` reads one or both logical documents. An optional natural-language `query` invokes
  semantic recall when the selected provider supports it; otherwise it returns the current
  bounded snapshot.
- `append` adds content to `user` or `memory`.
- `replace` replaces or deletes a uniquely matching `old_text` fragment.

Realtime may issue several calls in one turn when an utterance contains several durable changes;
the Gateway still produces only one follow-up response. Each write starts from the latest
document, and an exact replacement fails safely when its source fragment is missing or ambiguous.

## Client Control Plane

Replaceable clients can manage the same memory through two Gateway endpoints:

- `GET /api/memory` returns the current owner's bounded `user` and `memory` documents.
- `PATCH /api/memory` accepts the same exact edits as the Realtime memory tool, including
  `expectedRevision`; stale revisions return `409` so a client can reload instead of
  overwriting a concurrent change.

This is a document control plane, not a second memory store. It is owner-scoped by the Gateway,
passes writes through `FrontendMemoryRuntime`, and therefore works unchanged with the default
Markdown provider or an injected provider. Clients should render only the formats they
understand and preserve exact source text when issuing a delete or replacement.

## Replacing the Memory Provider

The built-in `USER.md` and `MEMORY.md` files are the default implementation, not a fixed Gateway
storage dependency. A host application can implement the public, versioned `MemoryProvider`
contract and inject it at the composition root:

```js
import { MEMORY_PROVIDER_PROTOCOL_VERSION } from 'qwen-audio-agent/memory-provider'
import { createGatewayApplication } from 'qwen-audio-agent/gateway-application'

const memoryProvider = {
  describe: () => ({
    protocolVersion: MEMORY_PROVIDER_PROTOCOL_VERSION,
    key: 'company-memory',
    label: 'Company Memory',
    capabilities: {
      semanticQuery: true,
      sessionObservation: true,
      audioStreamObservation: true,
    },
  }),
  list(ownerId, options) {
    return []
  },
  async apply(ownerId, changes, context) {
    return { changed: 0, documents: [] }
  },
  async query(ownerId, query, options, context) {
    return { memories: [], context: '' }
  },
  async observe(ownerId, exchange, context) {},
  observeAudio(ownerId, event, context) {},
  async flush(ownerId, context) {},
  health: () => ({ ok: true }),
  async close() {},
}

const gateway = createGatewayApplication({ memoryProvider })
```

Protocol v2 keeps the startup path deterministic and makes the complete memory lifecycle
replaceable:

- `describe()` identifies the provider, protocol version, and optional capabilities.
- `list()` is required and returns a synchronous, bounded Realtime snapshot. Remote providers
  must maintain that small cache in their adapter; the prompt path never waits on remote I/O.
- `apply()` receives explicit user-directed edits. The Gateway-owned `context` identifies the
  source, Session, Turn, and Trace separately from model-controlled changes.
- A provider advertising `semanticQuery` implements `query()` for natural-language recall.
- A provider advertising `sessionObservation` implements `observe()` to receive completed
  conversation exchanges. Optional `flush()` completes provider-owned session-boundary work.
- A provider advertising `audioStreamObservation` implements synchronous `observeAudio()`.
  It receives accepted PCM16 chunks plus speech/session boundary events. Because this hook is on
  the input hot path, it must only perform bounded in-memory work; file, network, model, and
  asynchronous processing belong in `observe()` or `flush()`.
- Optional `health()` and `close()` integrate provider diagnostics and lifecycle cleanup.

Capabilities are explicit. When `sessionObservation` is enabled, the built-in Markdown extractor
and preference learner are disabled; a conversation is never learned by two systems in parallel.
The provider then owns retention, sensitive-data filtering, deletion, and tenant isolation for
the exchanges it receives.
Protocol v1 providers remain accepted and keep their original `list()` / `apply()` behavior.

Realtime, automatic extraction, and tool handling depend only on `FrontendMemoryRuntime`; they
never access a vendor SDK, database, or Markdown file. The default configuration keeps the
existing Markdown provider active, so current users require no migration.
Third-party adapters own remote authentication, tenant mapping, cache refresh, and translation
into the public `user` and `memory` context semantics. The
[VoiceMem setup example](../scenarios/voicemem.md) demonstrates the same boundary through the
bundled connector and an example-owned Python sidecar.
