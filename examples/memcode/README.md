# Qwen Audio Agent Memcode Example

English | [中文](README_ZH.md)

This opt-in example injects Memcode through qwen-audio-agent's public
`MemoryProvider` v2 boundary. It does not add credentials or network work to
the default Gateway.

## What it does

- Explicit `memory` tool appends, replacements, and deletions update a small
  mode-0600 local snapshot and submit the same authoritative change to
  Memcode's durable personal v2 ingest API.
- Natural-language memory reads use Memcode semantic search.
- `list()` remains synchronous for the Realtime prompt by reading only the
  bounded local snapshot.
- The Memcode credential derives personal identity; the provider accepts only
  the configured Gateway owner and never sends a `user_id` or attribution
  override.
- Automatic transcript and audio observation stay disabled. Nothing is stored
  merely because a conversation occurred.

## Run from source

Requirements: the Node.js version declared by qwen-audio-agent and a Memcode
API key.

```bash
cd examples/memcode
npm install
cp .env.example .env.local
# edit .env.local and set MEMCODE_API_KEY
node --env-file=.env.local gateway.mjs
```

Open the Gateway URL printed by qwen-audio-agent. The command above is an
example launcher; normal qwen-audio-agent installation and frontend setup still
apply.

## Isolation, retention, and failures

The default owner is `user_personal`. A different owner is rejected before any
Memcode request, because one personal API key must never be reused as an
implicit cross-user fallback. Multi-user hosts should create one provider and
credential binding per authenticated owner.

The exact editable `user` and `memory` documents live at
`.qwen-audio/runtime/memory/memcode/snapshot.json`; it is written with mode
`0600` and contains memory content, so protect and retain that directory like
the rest of the Gateway's private state. Memcode owns the remote retention
policy. A remote ingest receipt is accepted before the local snapshot changes;
authentication, network, or provider failures therefore fail the write closed.
Because ingest is asynchronous, semantic search may briefly reflect the prior
version after an accepted correction, while the exact local document already
shows the new revision.

The provider does not log credentials, raw upstream errors, or memory content.
It passes no integration-attribution fields; Memcode assigns attribution from
the credential server-side.

## Test

```bash
npm test
```

Tests use an injected fake Memcode client and make no network requests.
