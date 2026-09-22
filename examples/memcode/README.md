# Qwen Audio Agent Memcode Integration Example

English | [中文](README_ZH.md)

This optional example connects [Memcode](https://memcode.in/), a hosted memory
service, through qwen-audio-agent's `MemoryProvider` v2 interface. It reuses the
frontend `memory` tool without changing the default Gateway. Memory submitted
through this provider is sent to the remote service.

## Core features

- **Replaceable memory:** Memcode-specific code and SDK dependencies stay in this example.
- **Local snapshots:** synchronous `list()` supplies the `user` and `memory` documents to the frontend prompt.
- **Semantic recall:** `query()` retrieves relevant memory for the frontend to answer.
- **Explicit edits:** `apply()` calculates edits locally and submits natural-language updates to Memcode.
- **Owner checks:** requests for an owner other than the configured Gateway owner are rejected.

## Architecture

| Component | Responsibility |
|---|---|
| qwen-audio-agent Gateway | Voice conversation, the memory tool, and provider lifecycle. |
| [MemcodeMemoryProvider](provider.mjs) | Local snapshots and mapping memory operations to remote APIs. |
| memcode-sdk | Authenticated requests to the independently hosted service. |
| Memcode | Remote memory processing, storage, and semantic search. |

`apply()` calls `ingestV2()`, polls `getIngestStatusV2()`, and updates the
snapshot only after the job reports completion. Pending operations and their
idempotency keys are persisted before submission; the next write or query can
resume them after a timeout or restart without blindly creating another job.
`query()` calls `searchV2()` and returns supporting material, leaving the final
answer to the frontend. See the limitations below.

## Quick start

Use the Node.js version required by the repository. From the repository root:

```bash
npm ci
npm run build
npm ci --prefix examples/memcode
cd examples/memcode
cp .env.example .env.local
```

Create a key in the [Memcode dashboard](https://app.memcode.in/dashboard?section=api-keys&integration=qwen-audio-agent),
selecting **Qwen Audio Agent** as the integration. Edit `.env.local` with the
key and your voice frontend configuration. For the default frontend:

```dotenv
MEMCODE_API_URL=https://memory.memcode.in
MEMCODE_API_KEY=your_memcode_api_key
DASHSCOPE_API_KEY=your_dashscope_api_key
AGENT_PROTOCOL=none
QWAUDIO_CONFIG_DIR=.qwen-audio/runtime
PORT=3102

```

The Memcode key does not authenticate the voice frontend. For another frontend,
use its own configuration instead of the default frontend key above.
The launcher disables automatic memory extraction and preference learning before
loading Gateway configuration. Only explicit memory operations are enabled.

From `examples/memcode`, start the Gateway:

```bash
node --env-file=.env.local gateway.mjs
```

Open `http://127.0.0.1:3102`, enable the microphone, and ask the assistant to
remember a preference. Start a new voice session and ask it to recall that
preference. Remote search may lag behind local edits. Press Ctrl+C to stop.

## Configuration and data

The default owner is `user_personal`; override it with
`QWEN_AUDIO_AGENT_PERSONAL_OWNER_ID` if needed. Remote identity comes from the
Memcode credential; the adapter sends no `user_id` or attribution override.

When started as above, snapshots live at
`examples/memcode/.qwen-audio/runtime/memory/memcode/snapshot.json`.
The launcher derives this path from `QWAUDIO_CONFIG_DIR` (relative paths use the
working directory). The file contains private memory and pending edits; writes request mode
`0600`. Do not commit it or `.env.local`.

Snapshots are bound to the owner and a hash of the endpoint and API key; the key
itself is not stored. A different key or endpoint, or an older unbound snapshot,
is rejected. Use a separate config directory for another account or rotated key;
existing state is never silently overwritten or migrated.
Remote retention is managed by Memcode.

## Current limitations

- **Bounded waiting:** a write waits up to 30 seconds per attempt. Timeout or an
  uncertain receipt reports an error and retains the pending operation for recovery;
  it does not claim success. `health()` is a local status snapshot, not a remote probe.
- **Remote edits need verification:** replacements and deletions are submitted as
  natural-language instructions, not exact remote record operations.
- **Embedding:** `sessionObservation: false` alone does not disable framework
  learning. Hosts not using this launcher must disable `QWEN_AUDIO_MEMORY_AUTO`
  and `QWEN_AUDIO_PREFERENCE_LEARNING` themselves for explicit-only writes.
  This adapter does not forward raw audio.
- **Document size:** keep the default 8,000-character limit, matching the framework's
  prompt projection. Snapshot loading rejects oversized data rather than truncating it.

## Tests

From `examples/memcode`:

```bash
npm test
```

Tests cover edits, failure/timeout recovery, credential binding, and the published
SDK with a simulated HTTP response. They make no external network requests and do
not establish the live service's semantic correction or deletion guarantees.

## Authors and acknowledgements

- [Vivek Gupta](https://github.com/vivekgupta-memcode): contributed the Memcode
  provider integration, example launcher, tests, and initial documentation in
  [PR #488](https://github.com/QwenAudio/qwen-audio-agent/pull/488).
- [Memcode](https://memcode.in/): provides the hosted memory service and SDK
  used by this example.
