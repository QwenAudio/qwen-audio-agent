# VoiceMem Memory Provider

This runnable example replaces qwen-audio-agent's complete personal-memory subsystem with
[VoiceMem](https://github.com/xzf-thu/VoiceMem). The voice frontend keeps the same `memory` tool
and context semantics while VoiceMem owns storage, automatic learning, consolidation, and
semantic retrieval.

`PROMPT.md` and `ASSISTANT.md` remain part of the assistant definition and are not replaced.

## Core features

- Replaces both logical memory layers: user preferences and durable facts.
- Preserves explicit read, append, replace, and delete operations through the existing
  `memory` tool.
- Observes completed voice Sessions and consolidates transcribed user messages in the
  background.
- Adds semantic recall without introducing VoiceMem-specific code into the Gateway.
- Isolates each Gateway owner in a separately hashed VoiceMem space.
- Disables the built-in extractor and preference learner, preventing duplicate learning.

## Architecture

| Component | Responsibility |
|---|---|
| qwen-audio-agent Gateway | Realtime conversation, memory tool, and provider lifecycle |
| Node.js adapter | `MemoryProvider` contract, bounded synchronous snapshot, owner isolation, and process supervision |
| Python sidecar | JSONL bridge to VoiceMem's public Python API |
| VoiceMem | Extraction, consolidation, structured storage, and semantic retrieval |
| Model provider | Chat model and embedding model used by VoiceMem |

The Gateway starts a long-running Python sidecar on demand and communicates over newline-delimited
JSON through standard input and output. Python dependencies therefore stay outside the Node.js
runtime and the public extension contract.

The current example sends transcribed user text, not raw microphone audio, to VoiceMem.

## Run the example

Requirements: the repository's supported Node.js version and Python 3.10 or later.

```bash
npm ci
python3.12 -m venv examples/voicemem-memory/.venv
examples/voicemem-memory/.venv/bin/pip install \
  --index-url https://mirrors.aliyun.com/pypi/simple/ \
  -r examples/voicemem-memory/sidecar/requirements.txt
cp examples/voicemem-memory/.env.example \
  examples/voicemem-memory/.env.local
```

Set `DASHSCOPE_API_KEY` in `.env.local`, then run:

```bash
cd examples/voicemem-memory
node --env-file=.env.local gateway.mjs
```

Open `http://127.0.0.1:3101`. Use `PORT=3102` if that port is already occupied. The adapter
automatically discovers the example's `.venv`.

The recommended Model Studio configuration uses `qwen3.8-flash` for extraction and consolidation,
and `text-embedding-v4` with dimension `1024` for semantic retrieval. See the example's
[complete setup guide](https://github.com/QwenAudio/qwen-audio-agent/tree/main/examples/voicemem-memory)
for all environment overrides.

## Try it

1. Say: “I live in Hangzhou, enjoy badminton, and would like you to call me Captain.”
2. Close or refresh the WebUI so the completed Session is consolidated.
3. Start a new Session and ask: “Where do I live, what do I enjoy, and how should you address me?”

Explicit updates enter the synchronous snapshot immediately. Session observation runs in the
background and does not block foreground voice conversation.

## Storage

The example stores state under `.qwen-audio/voicemem/` in its working directory:

| Path | Content |
|---|---|
| `profiles/<owner-hash>.json` | Bounded synchronous snapshot for explicit preferences and facts |
| `memory-spaces/<owner-hash>/` | VoiceMem SQLite data, metadata, and local Qdrant vectors |
| `observed-messages.json` | Bounded fingerprints that prevent duplicate ingestion after reconnects |

Production hosts should place this directory on durable storage and define their own credential,
retention, deletion, and tenant-mapping policies.

## Replace and extend

To integrate another memory system, implement the same versioned `MemoryProvider` contract and
inject it into `createGatewayApplication`. The Gateway and Realtime tool surface require no
vendor-specific changes. See [Long-Term Memory](../reference/memory.md) for the complete contract.

## Authors and acknowledgements

- [Xie Zhifei](https://github.com/xzf-thu) created and open-sourced VoiceMem.
- [Li Xu](https://github.com/x-lixu) designed the replaceable `MemoryProvider` boundary and
  implemented the Node.js/Python integration example.
