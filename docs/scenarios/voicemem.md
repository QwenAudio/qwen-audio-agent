# VoiceMem

qwen-audio-agent provides a Node.js connector for
[VoiceMem](https://github.com/xzf-thu/VoiceMem). This example installs VoiceMem and its Python
sidecar outside the core framework, then configures the Gateway to use them. The voice frontend
keeps the same `memory` tool and context semantics while VoiceMem owns storage, automatic
learning, consolidation, and semantic retrieval.

`PROMPT.md` and `ASSISTANT.md` remain part of the assistant definition and are not replaced.

## Core features

- Replaces both logical memory layers: user preferences and durable facts.
- Preserves explicit read, append, replace, and delete operations through the existing
  `memory` tool.
- Observes completed voice Sessions and consolidates transcripts or native audio in the
  background.
- Adds semantic recall while keeping VoiceMem-specific code inside its provider rather than the
  generic memory runtime.
- Isolates each Gateway owner in a separately hashed VoiceMem space.
- Disables the built-in extractor and preference learner, preventing duplicate learning.

## Architecture

| Component | Responsibility |
|---|---|
| qwen-audio-agent Gateway | Realtime conversation, memory tool, and provider lifecycle |
| Node.js connector | Framework-owned `MemoryProvider` interface, bounded synchronous snapshot, owner isolation, and process supervision |
| Example Python sidecar | JSONL bridge to VoiceMem's public Python API |
| VoiceMem | Extraction, consolidation, structured storage, and semantic retrieval |
| Model provider | Chat model and embedding model used by VoiceMem |

The Gateway connector starts the configured external Python sidecar on demand and communicates
over newline-delimited JSON through standard input and output. No VoiceMem Python code or
dependency is included in the core npm package.

`VOICEMEM_INPUT_MODE` selects the input path. `text` (the default) reuses Realtime
transcription. `audio` segments accepted PCM16 speech turns and invokes VoiceMem through
`ingest(audio=...)`, enabling its own ASR, emotion, environmental perception, and optional
voiceprint.
Typed messages use text in either mode.

## Install and run

Requirements: the repository's supported Node.js version and Python 3.10 or later.

```bash
npm ci
```

Install VoiceMem first by following its
[official instructions](https://github.com/xzf-thu/VoiceMem). For an isolated setup
with the tested dependency version, use:

```bash
python3.12 -m venv examples/voicemem/.venv
examples/voicemem/.venv/bin/pip install \
  --index-url https://mirrors.aliyun.com/pypi/simple/ \
  -r examples/voicemem/sidecar/requirements.txt
cp examples/voicemem/.env.example \
  examples/voicemem/.env.local
```

Set `DASHSCOPE_API_KEY` in `.env.local`, then run:

```dotenv
QWEN_AUDIO_MEMORY_PROVIDER=voicemem
VOICEMEM_SIDECAR=/absolute/path/to/examples/voicemem/sidecar/server.py
VOICEMEM_INPUT_MODE=text
```

```bash
cd examples/voicemem
node --env-file=.env.local gateway.mjs
```

Open `http://127.0.0.1:3101`. Use `PORT=3102` if that port is already occupied. The example
launcher prefers its `.venv`, otherwise uses `python3` from `PATH`, and discovers its sidecar.
To enable VoiceMem in the regular
Gateway instead, copy their absolute paths into `config.env` as `VOICEMEM_PYTHON` and
`VOICEMEM_SIDECAR`.

To try native audio memory, set this in `.env.local`:

```dotenv
VOICEMEM_INPUT_MODE=audio
VOICE_ENABLE_VOICEPRINT=false
```

The first call downloads and loads VoiceMem's local audio models and is substantially slower
than later calls. Temporary WAV files are removed after sidecar processing. VoiceMem does not
retain raw audio by default, but it can persist derived voiceprint data; production deployments
should configure `VOICE_SCENE` and retention for their privacy requirements. Voiceprint needs
VoiceMem's separately distributed speaker model; keep it disabled when that model is absent.

The recommended Model Studio configuration uses `qwen3.8-flash` for extraction and consolidation,
and `text-embedding-v4` with dimension `1024` for semantic retrieval. See the example's
[complete setup guide](https://github.com/QwenAudio/qwen-audio-agent/tree/main/examples/voicemem)
for all environment overrides.

## Try it

1. Say: “I live in Hangzhou, enjoy badminton, and would like you to call me Captain.”
2. Close or refresh the WebUI so the completed Session is consolidated.
3. Start a new Session and ask: “Where do I live, what do I enjoy, and how should you address me?”

Explicit updates enter the synchronous snapshot immediately. Session observation runs in the
background and does not block foreground voice conversation.

## Storage

The isolated example stores state under `.qwen-audio/runtime/memory/voicemem/`:

| Path | Content |
|---|---|
| `profiles/<owner-hash>.json` | Bounded synchronous snapshot for explicit preferences and facts |
| `memory-spaces/<owner-hash>/` | VoiceMem SQLite data, metadata, and local Qdrant vectors |
| `observed-messages.json` | Bounded fingerprints that prevent duplicate ingestion after reconnects |
| `audio-staging/` | Temporary WAV files used by native audio mode and removed after processing |

Production hosts should place this directory on durable storage and define their own credential,
retention, deletion, and tenant-mapping policies.

## Replace and extend

To integrate another memory system, implement the same versioned `MemoryProvider` contract and
inject it into `createGatewayApplication`. The Gateway and Realtime tool surface require no
vendor-specific changes. See [Long-Term Memory](../reference/memory.md) for the complete contract.

## Authors and acknowledgements

- [Xie Zhifei](https://github.com/xzf-thu) created and open-sourced VoiceMem.
- [Li Xu](https://github.com/x-lixu) designed the replaceable `MemoryProvider` boundary and
  implemented the built-in Node.js/Python integration.
