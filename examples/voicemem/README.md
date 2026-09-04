# Qwen Audio Agent VoiceMem Example

English | [中文](README_ZH.md)

This runnable example replaces qwen-audio-agent's complete personal-memory
subsystem with [VoiceMem](https://github.com/xzf-thu/VoiceMem). Users can state
preferences and durable facts in natural conversation, start a new voice
Session, and recall that information later.

`PROMPT.md` and `ASSISTANT.md` remain system instructions. The provider owns
user preferences, durable facts, semantic recall, automatic learning, and
session-boundary consolidation.

## Core features

- **Replaceable memory:** the Gateway depends only on the versioned
  `MemoryProvider` contract and contains no VoiceMem-specific logic.
- **Explicit preference updates:** the existing `memory` tool still supports
  precise reads, additions, replacements, and deletions.
- **Two input paths:** use existing Realtime transcripts by default, or switch to
  VoiceMem-native ASR, emotion, acoustic perception, and optional voiceprint.
- **Automatic learning:** completed user turns are consolidated by VoiceMem in
  the background after a voice Session disconnects.
- **Semantic recall:** natural-language memory queries use VoiceMem retrieval
  instead of requiring exact text matches.
- **User isolation:** each Gateway owner receives an independently hashed
  profile and VoiceMem memory space.
- **Single learning pipeline:** the built-in extractor and preference learner
  stay disabled when VoiceMem owns Session observation, avoiding duplicate
  memory extraction.

## Architecture

| Component | Responsibility |
|---|---|
| qwen-audio-agent Gateway | Realtime conversation, memory tools, and the provider lifecycle. |
| [`voicemem-provider.mjs`](voicemem-provider.mjs) | Node.js `MemoryProvider`, synchronous preference snapshot, user isolation, and process supervision. |
| [`sidecar/server.py`](sidecar/server.py) | Small JSONL process boundary around VoiceMem's public Python API. |
| VoiceMem | Memory extraction, consolidation, structured storage, and semantic retrieval. |
| Alibaba Cloud Model Studio | Recommended inference provider: Qwen3.8-Flash for memory processing and text-embedding-v4 for retrieval vectors. |

The Node.js Gateway starts one long-running Python sidecar on demand. Requests
and responses use newline-delimited JSON over standard input and output, so
Python dependencies do not leak into the Gateway runtime or its public
extension contract.

## Quick start

Requirements: Node.js as specified by the repository and Python 3.10 or later.
From the repository root:

```bash
npm ci
python3 --version # must be 3.10 or later
python3.12 -m venv examples/voicemem/.venv
examples/voicemem/.venv/bin/pip install \
  --index-url https://mirrors.aliyun.com/pypi/simple/ \
  -r examples/voicemem/sidecar/requirements.txt
cp examples/voicemem/.env.example \
  examples/voicemem/.env.local
```

Set your Alibaba Cloud Model Studio API key in `.env.local`, then start the
example. Its default configuration uses frontend-only mode and isolated local
runtime data, so it does not change the user's regular Gateway configuration:

```bash
cd examples/voicemem
node --env-file=.env.local gateway.mjs
```

Open `http://127.0.0.1:3101`. If another Gateway already uses that port, start
this example with `PORT=3102` and open `http://127.0.0.1:3102` instead.
The adapter discovers the example's `.venv` automatically. Set
`VOICEMEM_PYTHON` only when using a different Python environment.

## Recommended configuration

The example automatically maps `DASHSCOPE_API_KEY` to VoiceMem's
OpenAI-compatible client and applies these defaults:

```dotenv
DASHSCOPE_API_KEY=your_dashscope_api_key
OPENAI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
VOICEMEM_CHAT_MODEL=qwen3.8-flash
VOICEMEM_EMBEDDING_MODEL=text-embedding-v4
VOICEMEM_EMBED_DIM=1024
VOICEMEM_MEMORY_LANGUAGE=zh
VOICEMEM_INPUT_MODE=text
VOICE_ENABLE_VOICEPRINT=false
```

[`qwen3.8-flash`](https://help.aliyun.com/zh/model-studio/qwen3-8-flash)
performs memory extraction and consolidation;
[`text-embedding-v4`](https://help.aliyun.com/zh/model-studio/embedding)
provides semantic retrieval. The `OPENAI_*` names belong to VoiceMem's
compatible client; this configuration uses Model Studio credentials, endpoints,
and models throughout. Explicit `OPENAI_*` and `VOICEMEM_*` values override the
recommended defaults.

### Choose the memory input

```dotenv
# Default: reuse the Realtime transcript; fastest startup and lowest overhead
VOICEMEM_INPUT_MODE=text

# Native audio: send each accepted user speech turn to VoiceMem
VOICEMEM_INPUT_MODE=audio
```

Audio mode is not a renamed transcript path. The Gateway adapter segments the
microphone PCM16 stream by `turn_id`, writes a temporary WAV, and invokes
VoiceMem through `ingest(audio=...)`. VoiceMem then runs its own ASR plus
emotion, acoustic-environment analysis, and optional voiceprint. Typed messages have no
audio and fall back to text. The first audio use downloads and loads VoiceMem's
local audio models, so it is substantially slower than later calls. The
recommended ASR remains the default `VOICEMEM_ASR=funasr`. VoiceMem's speaker
model is not included in its Python package, so the recommended configuration
disables voiceprint. Enable it only after installing that model and setting
`VOICEMEM_SPEAKER_MODEL` or `VOICEMEM_MODELS_DIR`.

## Try it

1. Say: “I live in Hangzhou, enjoy badminton, and would like you to call me
   Captain.”
2. Close or refresh the WebUI so the completed Session is consolidated.
3. Start a new Session and ask: “Where do I live, what do I enjoy, and how
   should you address me?”

Explicit preferences are available immediately in the next Session. Automatic
VoiceMem extraction runs after disconnect and can take tens of seconds; it does
not block foreground voice conversation. Background observation and
consolidation allow up to 120 seconds, while interactive recall keeps the
shorter 30-second timeout. If the same user's consolidation is still running,
recall returns the synchronous preference snapshot immediately instead of
waiting behind background work.

## Storage

State is stored under `.qwen-audio/voicemem/` in the current working directory:

| Path | Content |
|---|---|
| `profiles/<owner-hash>.json` | Bounded synchronous snapshot for explicit user preferences and facts. |
| `memory-spaces/<owner-hash>/` | VoiceMem SQLite data, metadata, and local Qdrant vectors. |
| `observed-messages.json` | Bounded message fingerprints used to prevent duplicate ingestion after reconnects. |
| `audio-staging/` | Temporary WAV files awaiting sidecar processing in audio mode; removed afterward. |

Do not commit this directory. Production hosts should place it on durable
storage, supervise the sidecar, and define their own credential and tenant
mapping policy. The adapter does not log microphone audio. VoiceMem does not
retain raw audio by default, but audio mode can persist derived voiceprint data;
configure VoiceMem's `VOICE_SCENE` and retention policy for your privacy needs.

## Replace and extend

| Goal | Change |
|---|---|
| Use another OpenAI-compatible inference provider | Set `OPENAI_API_KEY`, `OPENAI_BASE_URL`, and the relevant `VOICEMEM_*` model variables. |
| Move memory to another persistent location | Pass `stateDirectory` when creating `VoiceMemProvider`. |
| Replace VoiceMem with another memory system | Implement the same versioned `MemoryProvider` contract and inject it into `createGatewayApplication`. |
| Switch between text and native audio | Set `VOICEMEM_INPUT_MODE=text` or `audio`. |

## Authors and acknowledgements

- [Xie Zhifei](https://github.com/xzf-thu): created and open-sourced VoiceMem,
  which provides the memory extraction, consolidation, and retrieval engine
  used by this example.
- [Li Xu](https://github.com/x-lixu): designed the replaceable `MemoryProvider`
  boundary and implemented the Node.js/Python integration example.
