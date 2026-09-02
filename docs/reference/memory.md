# Long-Term Memory

`MEMORY.md` is the long-term memory layer of the frontend context model: durable
facts and decisions used to understand the user and answer questions, with no
behavioral authority. For the full four-layer model, instruction conflict
ordering, and the persona layers (`ASSISTANT.md` / `USER.md`), see
[Assistant Profile and User Preferences](personalization.md).

`MEMORY.md` stores durable facts and decisions about the user—such as location, habits,
interests, relationships, projects, goals, and plans—in ordinary Markdown. It informs
understanding and answers but carries no behavioral authority. Content comes from two sources:

- **Explicitly requested**: When you say "remember, change, no longer" etc., the assistant
  generates precise Markdown edits. Multiple durable items in one utterance are handled as
  separate atomic operations in the same turn, followed by one final response.
- **Automatic reconciliation**: After a session ends, a lightweight text model fills gaps by
  routing explicit long-term interaction directives to `USER.md` and stable facts or decisions
  to `MEMORY.md`. Automatic reconciliation uses DashScope's `qwen-flash` model by default (reusing
  `DASHSCOPE_API_KEY`); it is automatically disabled when no API Key is available, and
  explicitly requested memory is unaffected. Set `QWEN_AUDIO_MEMORY_AUTO=off` to disable
  it globally; `QWEN_AUDIO_MEMORY_MODEL`, `QWEN_AUDIO_MEMORY_BASE_URL`, and
  `QWEN_AUDIO_MEMORY_API_KEY` can point to any OpenAI-compatible endpoint (including
  local Ollama).

Realtime and automatic reconciliation submit constrained Markdown changes through the same
memory service; neither writes the files directly. Reconciliation may recover a form of address
or reply preference the user explicitly stated, but never infer one, and it can never modify
`ASSISTANT.md`. Sensitive content is intercepted by dual filtering. `memory-audit.jsonl` records
patch outcomes, revisions, and errors without copying the full memory text. If something is
wrong, say "that one is wrong" or "forget it"; the assistant edits or removes the matching
Markdown text.

The frontend exposes one `memory` tool, with one atomic operation per call: `read` reads one or
both documents, `append` adds Markdown, and `replace` replaces or removes a uniquely matching
`old_text` fragment. Realtime may issue several calls in one turn when an utterance contains
several durable changes; the Gateway still produces only one follow-up response. Each write
starts from the latest document, and an exact replacement fails safely when its source fragment
is missing or ambiguous.

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

## Session Digests and Recall (off by default)

With `QWEN_AUDIO_SESSION_DIGEST=on`, each finished session records its topics and
a gist of at most 50 characters, retained for 90 days, so the `recall` tool can
answer "that thing we discussed the other day".

Digests are **not injected** into `instructions`: they change every session, and
injecting them would change the prompt prefix every session and invalidate the
prefix cache. They are an on-demand tool, not part of the context.

`recall` answers only "what we discussed" and "what work was dispatched". The
user's own documents go through the `knowledge` tool — see
[Knowledge Retrieval Provider](./knowledge.md).

A digest freezes the objective of dispatched work but **never its status**: status
is live, and a stored copy silently becomes wrong within days. Status is always
read from the task ledger at retrieval time. The ledger keeps terminal tasks for
three days; for older work the answer states that it was dispatched without
claiming a status.

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
  }),
  list(ownerId, options) {
    return []
  },
  async apply(ownerId, changes, context) {
    return { changed: 0, documents: [] }
  },
  health: () => ({ ok: true }),
  async close() {},
}

const gateway = createGatewayApplication({ memoryProvider })
```

`list()` must return a synchronous, bounded Realtime context snapshot. Remote providers should
maintain a local cache inside their adapter. `apply()` may be asynchronous. Its Gateway-owned
`context` identifies the source, Session, Turn, and Trace separately from model-controlled
changes. Returned documents are bounded, their scopes are normalized, and invalid or duplicate
documents are discarded.

Realtime, automatic extraction, and tool handling depend only on `FrontendMemoryRuntime`; they
never access a vendor SDK, database, or Markdown file. Without an injected provider, the existing
Markdown provider remains active, so current configuration and data require no migration.
Third-party adapters own remote authentication, tenant mapping, cache refresh, and translation
into the public `user` and `memory` document semantics.

## Logs

Logs use JSON Lines format. API Keys, Tokens, Authorization headers, Cookies, passwords,
and Secret fields are redacted before writing. By default, microphone audio, user
transcription text, model reply text, and task results are not logged. In the desktop
edition, you can open the log directory via "Settings → App → Logs." See
[configuration guide](../configuration/advanced.md#local-logs) for details.
