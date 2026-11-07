# Music Assistant

[English](README.md) | [中文](README_ZH.md)

Server-side example of a voice companion assistant for a music app. It wires the
qwen-audio-agent Gateway into a "talk about music" voice assistant for an external
mobile client (here: [MoeKoeMusic-Mobile](https://github.com/MoeKoeMusic/MoeKoeMusic-Mobile),
an Expo / React Native music player) over the GCP WebSocket protocol, enabling realtime
voice conversation while listening to music. The example demonstrates two extension
points: Frontend Profile persona injection (`QWEN_AUDIO_FRONTEND_PROFILE`) and native
mobile client integration ([GCP 7.0](../../docs/gateway-protocol.md)).

## Core capabilities

- Realtime voice conversation: the client streams 16 kHz PCM16 audio; the Gateway returns 24 kHz speech and transcripts (server-side VAD, interruption supported).
- Music companion persona: injected via `frontend-profile.json` + `assistant/music-companion.md`; colloquial, brief replies.
- Protocol smoke test `verify.mjs`: zero-dependency Gateway handshake check (`session.hello` → `session.ready`).
- Future work (not in this example): voice-controlled playback (skip / search / recommend), requiring backend Agent tools.

## Architecture and boundaries

| Part | Responsibility |
| --- | --- |
| qwen-audio-agent Gateway | Sessions, voice provider (DashScope Realtime), VAD, audio transcoding; started via the public entry `server/src/index.mjs` |
| This example | env wiring only (`start.mjs`) + persona files (Frontend Profile); zero core code changes, zero extra npm dependencies |
| Mobile client (external repo) | Microphone capture, PCM playback, UI; connects via `ws://<gateway>/api/realtime`; never sees the API key |

Data flow: client microphone PCM16(base64) → `input_audio_buffer.append` → Gateway →
DashScope Realtime → `audio.delta` (24 kHz PCM) / `transcript.*` → client playback and
captions. The persona is injected through the
[Frontend Profile](../../docs/extensions.md) extension point; the example imports no
private runtime internals. The Gateway process is started and stopped by the user
(`npm run example:music-assistant`, Ctrl+C to exit).

## Quick start

Prerequisites: Node.js ≥ 22.22.2 (see root `.nvmrc`), root dependencies installed
(`npm install`), and a DashScope API key (from the
[Alibaba Cloud Model Studio console](https://bailian.console.aliyun.com/)).

```bash
# Terminal 1: repository root
cd qwen-audio-agent
cp examples/music-assistant/.env.example examples/music-assistant/.env
# Edit .env and fill in DASHSCOPE_API_KEY
npm run example:music-assistant        # Starts the Gateway, default ws://127.0.0.1:3101

# Terminal 2: verify the handshake
node examples/music-assistant/verify.mjs
# Expected output: verify ok: session.ready received
```

Client integration (the iOS Simulator shares the Mac network stack, so loopback needs no
token): in MoeKoeMusic-Mobile, set the Gateway address to `ws://127.0.0.1:3101` on the
settings screen, tap the voice assistant button on the player screen, and say something —
you should hear a reply. For a physical device or another machine, see the configuration
below.

## Configuration and data

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `DASHSCOPE_API_KEY` | yes | - | DashScope Realtime credential; stays on the Gateway |
| `QWEN_AUDIO_REALTIME_MODEL` | no | `qwen-audio-3.1-realtime-plus` | Voice model |
| `QWEN_AUDIO_FRONTEND_PROFILE` | no | this example's `frontend-profile.json` | Not overridden when already set, so personas can be swapped |
| `HOST` / `PORT` | no | `127.0.0.1` / `3101` | Listen address; set `HOST=0.0.0.0` for physical devices |
| `QWEN_AUDIO_GATEWAY_ACCESS_TOKEN` | yes for remote | - | Fixed access key (≥ 24 chars); clients send it via `Authorization: Bearer` |

Configuration precedence: shell environment > this directory's `.env` > defaults above.
For general Gateway configuration see the
[configuration docs](../../docs/configuration.md). Audio data is sent from the Gateway to
DashScope; the example itself persists nothing locally, and stopping the Gateway ends the
session. Delete `.env` to clean up credentials; data retention on the DashScope side is
governed by its terms of service.

## Validation and limitations

Automated smoke test: `node examples/music-assistant/verify.mjs [ws://host:port]`,
expected to print `verify ok: session.ready received` with the negotiated protocol
version and capabilities, exit code 0. For a remote Gateway, set the
`QWEN_AUDIO_GATEWAY_ACCESS_TOKEN` environment variable. The real voice path (a billed
DashScope call) must be validated by speaking from a client: the user's speech is
transcribed, assistant audio is audible, and the persona style is 1–3 colloquial Chinese
sentences.

Known limitations:

- No tool calls; the assistant cannot actually control the player (its persona states this honestly).
- The Gateway allows one active client per user: if verify.mjs and a real client connect at the same time, the later one receives `client_occupied`.
- With the client on speaker, the assistant's voice may feed back into the microphone and cause self-interruption; headphones are recommended (client-side concern, see MoeKoeMusic-Mobile).
- Not validated on physical Android devices; iOS Simulator / device paths are covered by MoeKoeMusic-Mobile integration testing.

## Replacement and extension

- Change the persona: edit `assistant/music-companion.md`, or copy this directory and point `frontend-profile.json`'s `assistant` elsewhere.
- Add tools (e.g. real playback control): follow the [customer-service](../customer-service/) `toolSources.mcp` and `createGatewayApplication` composition-root pattern to expose client playback capabilities to the assistant via MCP / a backend Agent.
- Change the voice model: set `QWEN_AUDIO_REALTIME_MODEL` in `.env` (available models in `shared/realtime-model-catalog.mjs`).
- Restore the default Gateway (no persona): run `npm start` at the repository root without setting `QWEN_AUDIO_FRONTEND_PROFILE`.

## Authors and acknowledgements

- Example author: Juhayna — Gateway wiring, persona, verify script, and the MoeKoeMusic-Mobile client integration.
- Credits to the upstream project [qwen-audio-agent](https://github.com/QwenAudio/qwen-audio-agent) (Gateway, GCP protocol, Frontend Profile extension point) and the [DashScope Realtime](https://help.aliyun.com/zh/model-studio/) voice model service; the client is the separate open-source project [MoeKoeMusic-Mobile](https://github.com/MoeKoeMusic/MoeKoeMusic-Mobile). This example does not imply official upstream endorsement.
