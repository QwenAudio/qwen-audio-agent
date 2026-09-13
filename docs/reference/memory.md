# Long-Term Memory

The Gateway exposes memory through two logical documents: `user` for explicit long-term
personalization and `memory` for durable facts and decisions. The default provider stores them
as `USER.md` and `MEMORY.md`; an external provider may use a different physical model while
preserving the same public semantics. For the four context layers and conflict ordering, see
[Personalization and Memory](personalization.md).

## Default Markdown provider

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

## View, Edit, and Remove

Automatic reconciliation learns only from newly recorded conversation, not history restored
after a restart. Repeated disconnects do not reuse the same batch. Successful client/API or
memory-tool edits discard pending pre-edit evidence and invalidate stale learning results.
Built-in learning commits and explicit edits are serialized per user: an already-issued write
finishes first, while superseded queued evidence cannot commit after the edit succeeds.
The visible chat history stays intact, and later new conversation can still be learned.
Exact Markdown edits preserve unrelated entries, including identical text in other sections;
only append-only requests retain the existing whole-document cleanup behavior.

Ask “What do you remember about me?” to inspect stored information, or “Change my address to…”
and “Forget that entry” to update it. With the default implementation, you can also edit
`USER.md` and `MEMORY.md` in the shared data directory. Direct file edits apply to the next
voice session; tool edits apply immediately. A new conversation does not clear long-term memory.

## The `memory` tool

See [Memory Provider](memory-provider.md#the-memory-tool) for operations and developer parameters.

## Client Control Plane

See [Memory Provider](memory-provider.md#client-control-plane) for custom-client read/write interfaces.

## Session Digests and Recall (off by default)

With `QWEN_AUDIO_SESSION_DIGEST=on`, each finished session records its topics and
a gist of at most 50 characters, retained for 90 days, so the `recall` tool can
answer "that thing we discussed the other day".

Digests are **not injected** into `instructions`: they change every session, and
injecting them would change the prompt prefix every session and invalidate the
prefix cache. They are an on-demand tool, not part of the context.

`recall` answers only "what we discussed" and "what work was dispatched". Personal facts and
preferences are read through the `memory` tool; user-provided reference documents use the
`knowledge` tool — see [Knowledge Retrieval Provider](./knowledge.md).
Named lists use `notes`; they are neither long-term memories nor backend work state.

A digest freezes the objective of dispatched work but **never its status**: status
is live, and a stored copy silently becomes wrong within days. Status is always
read from the task ledger at retrieval time. The ledger keeps terminal tasks for
three days; for older work the answer states that it was dispatched without
claiming a status.

Work still in the ledger includes a `task_id` that `get_agent_task_status` can use to retrieve
current details, including work from earlier sessions. Pruned or inaccessible records omit the ID;
the assistant must not invent a query target from the summary.

## Optional VoiceMem Connector

The package ships only a Node.js `MemoryProvider` connector. VoiceMem itself, its Python
dependencies, and the small integration sidecar stay outside the core npm package. After
installing them through the setup example, select the connector in `config.env`:

```dotenv
QWEN_AUDIO_MEMORY_PROVIDER=voicemem
VOICEMEM_PYTHON=/absolute/path/to/python
VOICEMEM_SIDECAR=/absolute/path/to/voicemem-sidecar.py
VOICEMEM_INPUT_MODE=text
```

`text` reuses Realtime transcripts. `audio` sends per-turn audio to VoiceMem's own ASR and
acoustic perception. Because VoiceMem advertises `sessionObservation`, it exclusively owns the
`user` and `memory` layers, semantic recall, and session-end learning; Markdown reconciliation
does not run in parallel. State defaults to `memory/voicemem/` under the user data directory.
Switching back to `markdown` neither deletes VoiceMem state nor migrates data between providers.
See the [VoiceMem setup example](../scenarios/voicemem.md) for external installation, the sidecar,
and recommended Model Studio configuration.

Embedded hosts may also import `VoiceMemProvider` from
`qwen-audio-agent/voicemem-provider` and inject it into `createGatewayApplication` explicitly.

## Replacing the Memory Provider

See [Memory Provider](memory-provider.md) for interfaces, lifecycle, and optional audio observation.
Switching Providers does not automatically migrate another store; back up according to that system's requirements.

## Logs

Logs use JSON Lines format. API Keys, Tokens, Authorization headers, Cookies, passwords,
and Secret fields are redacted before writing. By default, microphone audio, user
transcription text, model reply text, and task results are not logged. In the desktop
edition, you can open the log directory via "Settings → App → Logs." See
[configuration guide](../configuration/advanced.md#local-logs) for details.
