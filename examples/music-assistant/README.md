# Music Assistant

[English](README.md) | [中文](README_ZH.md)

**Server-side example** of a voice companion assistant for a music app. It wires the
qwen-audio-agent Gateway into a "talk about music — and control playback by voice"
assistant that an external mobile client connects to over the GCP WebSocket protocol,
enabling realtime voice conversation while listening to music.

> **The client code is NOT in this repository.** It lives in a separate repo:
> 👉 **https://github.com/juhayna-zh/VoiceAgent-MoeKoeMusic-Mobile**
> (an Expo / React Native music player with this assistant embedded; it handles microphone
> capture, PCM playback, the UI, and **the actual execution of the player tools**.)

The example demonstrates two extension points: **Frontend Profile persona injection**
(`QWEN_AUDIO_FRONTEND_PROFILE`) and **native mobile client integration**
([GCP 7.0](../../docs/gateway-protocol.md)). The backend has **zero core code changes and
zero extra npm dependencies** — only env wiring plus persona files.

## Core capabilities

- **Realtime voice conversation**: the client streams 16 kHz PCM16 audio; the Gateway returns
  24 kHz speech and transcripts (server-side VAD, interruption supported).
- **Music companion persona "Qwen"**: injected via `frontend-profile.json` +
  `assistant/music-companion.md`; colloquial, brief replies (1–3 sentences).
- **Voice-controlled playback**: the assistant can call a set of **client-owned tools** to
  actually operate the App player — skip, search, play a playlist, like a track, read lyrics,
  and more (see next section).
- **World-knowledge answers**: the Gateway's built-in retrieval tools (`web_search` /
  `fetch_url`, enabled by default) let the persona answer song/artist questions by combining
  "fetch lyrics + web search" over multiple steps instead of guessing from memory.

## Tools the assistant can call

There are two kinds. **Client tools** are registered by the mobile client in `session.hello`
via the `client.tools` capability; the Gateway maps them into DashScope native
function-calling. When the model decides to call one, the Gateway sends a
`client.action.request`, the **client executes it locally**, and returns a
`client.action.result`. The backend does not implement these tools.

**Client tools (executed locally in the App)**

| Tool | Purpose |
| --- | --- |
| `player_control` | play / pause / next / previous |
| `player_stop` | stop and clear the playback queue |
| `player_set_mode` | sequence / shuffle / single-loop |
| `player_seek` | seek to an absolute position, or relative fast-forward / rewind |
| `player_set_volume` | set volume (0–1) |
| `player_get_state` | current track / playing state / progress / volume / queue position |
| `player_get_queue` | list the playback queue (paged) |
| `track_set_like` | add / remove the current track in "Favorites" |
| `track_get_lyrics` | timestamped lyrics of the current track, marking the line being sung |
| `music_search_songs` | search songs (returns candidates; does not auto-play) |
| `music_search_playlists` | search playlists (returns candidates with playlist id) |
| `music_play_songs` | search and start playing from a result, queueing the rest |
| `music_play_playlist` | play a playlist by id or by name |
| `music_play_daily_recommend` | play the "Daily Recommend" feed |

**Gateway built-in tools (executed on the backend, enabled by default)**

| Tool | Purpose |
| --- | --- |
| `web_search` | web search, returns summaries with source citations |
| `fetch_url` | fetch the body of a given URL |

> Disable the built-in retrieval tools with `QWEN_AUDIO_WEB_TOOLS_ENABLED=false`; configure
> the search provider with `QWEN_AUDIO_WEB_SEARCH_PROVIDER` (see the repo-root `.env.example`
> and the configuration docs).

## Architecture and boundaries

| Part | Responsibility | Location |
| --- | --- | --- |
| qwen-audio-agent Gateway | Sessions, voice provider (DashScope Realtime), VAD, audio transcoding, persona injection, built-in retrieval, mapping client tools into function-calling | This repo, started via the public entry `server/src/index.mjs` |
| This example | env wiring only (`start.mjs`) + persona files (Frontend Profile); zero core changes, zero extra dependencies | `examples/music-assistant/` |
| Mobile client | Microphone capture, PCM playback, UI, **registers and executes the player tools** | Separate repo [VoiceAgent-MoeKoeMusic-Mobile](https://github.com/juhayna-zh/VoiceAgent-MoeKoeMusic-Mobile) |

Data flow:

```
client microphone PCM16(base64)
  → input_audio_buffer.append → Gateway → DashScope Realtime
  → audio.delta (24 kHz PCM) / transcript.* → client playback and captions

when the model decides to operate the player:
  Gateway → client.action.request(client.tool.*) → client executes locally → client.action.result → Gateway → model
```

The persona is injected through the [Frontend Profile](../../docs/extensions.md) extension
point; the example imports no private runtime internals. The Gateway process is started and
stopped by the user (`npm run example:music-assistant`, Ctrl+C to exit). The API key stays on
the Gateway; the client never sees it.

## Deployment

Three steps: **① start the backend Gateway → ② run the client App → ③ fill in the backend
address and token inside the App.**

Prerequisites: Node.js ≥ 22.22.2 (see root `.nvmrc`), root dependencies installed
(`npm install`), and a DashScope API key (from the
[Alibaba Cloud Model Studio console](https://bailian.console.aliyun.com/)).

### ① Start the backend Gateway

```bash
# at the repository root
cd qwen-audio-agent
cp examples/music-assistant/.env.example examples/music-assistant/.env
# Edit .env: fill in DASHSCOPE_API_KEY
#           for a physical phone also set HOST=0.0.0.0 and
#           QWEN_AUDIO_GATEWAY_ACCESS_TOKEN (>= 24 chars)
npm run example:music-assistant        # starts the Gateway, default ws://127.0.0.1:3101
```

Optional: run the handshake smoke test in a second terminal.

```bash
node examples/music-assistant/verify.mjs
# Expected output: verify ok: session.ready received
```

### ② Run the client App

The client is a separate repository; see its README for build/run instructions:
👉 **https://github.com/juhayna-zh/VoiceAgent-MoeKoeMusic-Mobile**

### ③ Connect the App to the backend

Open the App's **Settings** screen and fill in the voice-assistant connection info:

| Field | What to enter |
| --- | --- |
| **Gateway address** | The backend ws address, of the form `ws://<backend-host-IP>:3101` — enter up to the port only (the App appends `/api/realtime`). The iOS Simulator shares the Mac network stack, so use `ws://127.0.0.1:3101`. |
| **Token** | The **same** value as `QWEN_AUDIO_GATEWAY_ACCESS_TOKEN` in the backend `.env`. **Loopback (Simulator / local) needs no token**; a phone or another machine must set it. |

Physical-device / cross-machine notes:

- **LAN**: the phone and the backend host must be on the same network (e.g. the phone's
  personal hotspot); note the backend host's LAN IP.
- **Public internet**: the backend server needs a public IP and the TCP port open; prefer
  `wss://` (put TLS / a reverse proxy in front of the Gateway) — plaintext `ws://` is insecure.

Then open the **Voice** tab at the bottom of the App and tap **Wake**; say something and you
should hear a reply. The assistant stays resident across pages afterward (a floating orb is
visible); return to the conversation or tap **Pause** at any time.

## Configuration and data

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `DASHSCOPE_API_KEY` | yes | - | DashScope Realtime credential; stays on the Gateway |
| `QWEN_AUDIO_REALTIME_MODEL` | no | `qwen-audio-3.1-realtime-plus` | Voice model |
| `QWEN_AUDIO_FRONTEND_PROFILE` | no | this example's `frontend-profile.json` | Not overridden when already set, so personas can be swapped |
| `HOST` / `PORT` | no | `127.0.0.1` / `3101` | Listen address; set `HOST=0.0.0.0` for physical devices |
| `QWEN_AUDIO_GATEWAY_ACCESS_TOKEN` | yes for remote | - | Fixed access key (≥ 24 chars); clients send it via `Authorization: Bearer` |
| `QWEN_AUDIO_WEB_TOOLS_ENABLED` | no | `true` | Disable the built-in retrieval tools (`web_search` / `fetch_url`) |

Configuration precedence: shell environment > this directory's `.env` > defaults above.
For general Gateway configuration see the [configuration docs](../../docs/configuration.md).
Audio data is sent from the Gateway to DashScope; the example itself persists nothing
locally, and stopping the Gateway ends the session. Delete `.env` to clean up credentials;
data retention on the DashScope side is governed by its terms of service.

## Validation and limitations

Automated smoke test: `node examples/music-assistant/verify.mjs [ws://host:port]`, expected
to print `verify ok: session.ready received` with the negotiated protocol version and
capabilities, exit code 0. For a remote Gateway, set the
`QWEN_AUDIO_GATEWAY_ACCESS_TOKEN` environment variable. The real voice path (a billed
DashScope call) must be validated by speaking from a client: the user's speech is
transcribed, assistant audio is audible, the persona style is 1–3 colloquial Chinese
sentences, and playback commands (e.g. "next track", "play daily recommend") actually change
the App's playback state.

Known limitations:

- The Gateway allows one active client per user: if `verify.mjs` and a real client connect at
  the same time, the later one receives `client_occupied`.
- With the client on speaker, the assistant's voice may feed back into the microphone and
  cause self-interruption; headphones are recommended (client-side concern, see the client repo).

## Replacement and extension

- **Change the persona**: edit `assistant/music-companion.md`, or copy this directory and point
  `frontend-profile.json`'s `assistant` elsewhere. The tools described in the persona must match
  what the client actually registers.
- **Add / remove playback tools**: the tools are **client-owned** — register and execute them in
  the client repo
  [VoiceAgent-MoeKoeMusic-Mobile](https://github.com/juhayna-zh/VoiceAgent-MoeKoeMusic-Mobile)
  (`client.tools` in `session.hello`) and update the persona accordingly; no backend change is
  needed. To run tools on the **backend** instead, follow the [customer-service](../customer-service/)
  `toolSources.mcp` and `createGatewayApplication` composition-root pattern to expose them via
  MCP / a backend Agent.
- **Change the voice model**: set `QWEN_AUDIO_REALTIME_MODEL` in `.env` (available models in
  `shared/realtime-model-catalog.mjs`).
- **Restore the default Gateway (no persona)**: run `npm start` at the repository root without
  setting `QWEN_AUDIO_FRONTEND_PROFILE`.
