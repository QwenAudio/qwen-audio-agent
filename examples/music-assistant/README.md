# Music Assistant

English | [中文](README_ZH.md)

Server-side configuration example for music conversation and voice-controlled playback.
It combines the standard qwen-audio-agent Gateway with a music companion persona and the
external [VoiceAgent-MoeKoeMusic-Mobile](https://github.com/juhayna-zh/VoiceAgent-MoeKoeMusic-Mobile)
client. It demonstrates Frontend Profile injection and [GCP 7.0](../../docs/gateway-protocol.md)
client-owned tools, without core changes or extra server dependencies. The mobile App and
its player implementation are not included in this repository or the default application.

## Core capabilities

- **Realtime voice conversation**: the client streams 16 kHz PCM16 audio; the Gateway returns
  24 kHz speech and transcripts (server-side VAD, interruption supported).
- **Music companion persona "Qwen"**: injected via `frontend-profile.json` +
  `assistant/music-companion.md`; colloquial, brief replies (1–3 sentences).
- **Voice-controlled playback**: the assistant can call a set of **client-owned tools** to
  actually operate the App player — skip, search, play a playlist, like a track, read lyrics,
  and more (see next section).
- **World-knowledge answers**: the Gateway's built-in retrieval tools (`web_search` /
  `fetch_url`, enabled by default) let the assistant look up song/artist information alongside
  lyrics; availability depends on the configured search provider and network.

### Tools the assistant can call

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
| qwen-audio-agent Gateway | Sessions, voice provider (DashScope Realtime), VAD, audio transcoding, persona injection, built-in retrieval, mapping client tools into function-calling | This checkout's standard Gateway process |
| This example | Environment wiring and Frontend Profile persona files | [start.mjs](start.mjs), [frontend-profile.json](frontend-profile.json) |
| Mobile client | Microphone capture, PCM playback, UI, **registers and executes the player tools** | Separate repo [VoiceAgent-MoeKoeMusic-Mobile](https://github.com/juhayna-zh/VoiceAgent-MoeKoeMusic-Mobile) |

Data flow:

```
client microphone PCM16(base64)
  → input_audio_buffer.append → Gateway → DashScope Realtime
  → audio.delta (24 kHz PCM) / transcript.* → client playback and captions

when the model decides to operate the player:
  Gateway → client.action.request(client.tool.*) → client executes locally → client.action.result → Gateway → model
```

The persona uses the public [Frontend Profile](../../docs/reference/frontend-profile.md)
extension point. Playback commands use the App's local tools, not a phone-control Agent
or background ACP tasks. Existing backend settings are still inherited; set
`AGENT_PROTOCOL=none` in the example `.env` if you want frontend-only operation.

The user starts and stops the Gateway and the external App/development server separately.
The model API key stays on the Gateway; only the Gateway access token goes in the App.

## Quick start

Prerequisites: Node.js 22.22.2 (the version in [`.nvmrc`](../../.nvmrc)), npm ≥ 10,
Git, and a DashScope API key with access to the selected realtime model from the
[Model Studio console](https://bailian.console.aliyun.com/). Real voice calls may incur charges.
The external App targets iOS/Android and needs the corresponding native build tools
(macOS/Xcode for local iOS builds; Android SDK for local Android builds).

### 1. Start the Gateway

```bash
# Terminal 1, from the parent directory of this checkout
cd qwen-audio-agent
npm ci
cp -n examples/music-assistant/.env.example examples/music-assistant/.env
# Edit the example .env: fill in QWEN_AUDIO_REALTIME_API_KEY.
# For a physical phone, also set HOST=0.0.0.0 and
# QWEN_AUDIO_GATEWAY_ACCESS_TOKEN (a random token of >= 24 characters).
# Optional: AGENT_PROTOCOL=none to avoid using an existing backend Agent.
npm run example:music-assistant        # starts the Gateway, default ws://127.0.0.1:3101
```

Use a fresh `.env` only on first setup; keep any existing settings. Review configuration
and data reuse below before starting, and do not share a state directory with another
running Gateway.

### 2. Build and run the external App

In a separate terminal, from a directory where you keep external projects:

```bash
git clone --recurse-submodules https://github.com/juhayna-zh/VoiceAgent-MoeKoeMusic-Mobile.git
cd VoiceAgent-MoeKoeMusic-Mobile
```

Follow the client's [build instructions](https://github.com/juhayna-zh/VoiceAgent-MoeKoeMusic-Mobile#-部署与运行)
for dependencies and the API submodule. Clone the fork above, not the base player repository
currently shown in its README. Its [package.json](https://github.com/juhayna-zh/VoiceAgent-MoeKoeMusic-Mobile/blob/master/package.json)
provides `npm run ios` / `npm run android` and development-build scripts. It uses
`react-native-audio-api`, which requires a native development build;
[Expo Go does not include this native module](https://docs.swmansion.com/react-native-audio-api/docs/fundamentals/getting-started/).
Starting `expo start` alone does not build the native App.

### 3. Connect and try one interaction

Open the App's **Settings** screen and fill in the voice-assistant connection info:

| Field | What to enter |
| --- | --- |
| **Gateway address** | The backend ws address, of the form `ws://<backend-host-IP>:3101` — enter up to the port only (the App appends `/api/realtime`). The iOS Simulator shares the Mac network stack, so use `ws://127.0.0.1:3101`. |
| **Token** | The **same** value as `QWEN_AUDIO_GATEWAY_ACCESS_TOKEN` in the backend `.env`. **Loopback (Simulator / local) needs no token**; a phone or another machine must set it. |

Physical-device / cross-machine notes:

- **LAN**: the phone and the backend host must be on the same network (e.g. the phone's
  personal hotspot); note the backend host's LAN IP.
- **Public internet**: use `wss://` behind TLS / a reverse proxy; do not send tokens or audio
  over public plaintext `ws://`. See [remote access](../../docs/operations/remote-access.md).

Open the App's **Voice** tab, allow microphone access, tap **Wake**, and say “你好，介绍一下你自己”.
Expected result: a transcript and an audible short reply. With playable music in the queue,
say “下一首” and check that the App changes tracks. Login, favorites, and recommendations
depend on the player's music service/account and available content.

To stop, tap **Pause** or close the App, stop its development server with Ctrl+C, then
stop the Gateway with Ctrl+C in Terminal 1. This does not erase persisted data.

## Configuration and data

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `QWEN_AUDIO_REALTIME_API_KEY` | yes | - | DashScope Realtime credential; stays on the Gateway |
| `QWEN_AUDIO_REALTIME_PROVIDER` | fixed | `dashscope` | Enforced by this example's launcher |
| `QWEN_AUDIO_REALTIME_MODEL` | no | `qwen-audio-3.1-realtime-plus` | Voice model |
| `QWEN_AUDIO_FRONTEND_PROFILE` | no | this example's `frontend-profile.json` | Override in the shell or example `.env` to swap personas |
| `HOST` / `PORT` | no | `127.0.0.1` / `3101` | Listen address; set `HOST=0.0.0.0` for physical devices |
| `QWEN_AUDIO_GATEWAY_ACCESS_TOKEN` | yes for remote | - | Fixed access key (≥ 24 chars); clients send it via `Authorization: Bearer` |
| `QWEN_AUDIO_WEB_TOOLS_ENABLED` | no | `true` | Disable the built-in retrieval tools (`web_search` / `fetch_url`) |
| `AGENT_PROTOCOL` | no | inherited; otherwise none | Not needed for music tools; set `none` explicitly to disable an existing backend |

For ordinary settings, precedence is shell environment > example `.env` > repository
`.env.local` > repository `.env` > user `config.env` > Gateway defaults. The launcher
first forces DashScope and fills in the model/profile defaults when absent from the shell
and example `.env`; those values therefore take precedence over repository/user files.
Other settings, including backend Agents, tools, memory, and directory overrides, are reused.
See the [configuration reference](../../docs/configuration.md).

The standard Gateway persists data; this example is not an isolated or ephemeral instance:

| Data | Default location |
| --- | --- |
| Shared settings, persona, identity | `~/.config/qwaudio/config.env`, `ASSISTANT.md`, `identity.env` |
| Preferences, memory, notes | `~/.config/qwaudio/data/` |
| Gateway task/session state and logs | `~/.config/qwaudio/state/` (logs in `state/logs/`) |

`QWAUDIO_CONFIG_DIR` (or `XDG_CONFIG_HOME`) changes the product root;
`QWAUDIO_DATA_DIR`, `QWAUDIO_STATE_DIR`, and `QWAUDIO_CACHE_DIR` override individual directories.
Startup reuses existing files and creates missing standard files; it does not replace existing
configuration with the example's settings. Memory, stored task/session state, and logs survive
shutdown. What is recorded depends on the enabled features; see the shared configuration docs.

Audio, conversation context, and tool results are sent to DashScope. Enabled search tools
send queries/URLs to search services or target sites; the App contacts its music services.
Inherited backend or memory services may send additional data according to their configuration.
The App manages its own local storage. Local cleanup does not delete provider-side records.

Keep `.env`, API keys, access tokens, and `identity.env` private. To clean up, stop the Gateway,
confirm the effective paths, back up needed data, and remove only files/settings owned by this
test. Deleting the example `.env` removes neither shared state nor credentials stored elsewhere;
do not delete the shared `~/.config/qwaudio` tree, which may contain other assistants' data.
Remote retention is governed by the respective services.

## Validation and limitations

From the repository root:

```bash
# Local regression tests; mocked WebSocket peers, no cloud voice calls
node --test test/music-assistant-example.test.mjs

# Terminal 2, with the Gateway running and the App disconnected
node examples/music-assistant/verify.mjs
# Optional remote target: node examples/music-assistant/verify.mjs ws://host:port
```

The regression tests should pass. The handshake check should print
`verify ok: session.ready received`, the negotiated protocol/capabilities, and exit 0.
For remote verification, export `QWEN_AUDIO_GATEWAY_ACCESS_TOKEN` in that terminal;
`verify.mjs` does not load the example `.env`. A successful handshake does not verify
DashScope audio, native App builds, or playback-tool execution.

Real-service acceptance requires the interaction above on an actual client, including
audible speech, transcripts, short Chinese replies, and an observed playback change.
These cloud/physical-device checks are not covered by the local tests or claimed as
validated here; record the client revision, OS/device, model, and result when performing them.

Known limitations:

- The Gateway allows one active client per user: if `verify.mjs` and a real client connect at
  the same time, the later one receives `client_occupied`.
- With the client on speaker, the assistant's voice may feed back into the microphone and
  cause self-interruption; headphones are recommended (client-side concern, see the client repo).
- Native audio permissions/build compatibility and music-service availability belong to
  the external client; browser/Expo Go behavior is not an equivalent acceptance test.

## Replacement and extension

- **Change the persona**: edit `assistant/music-companion.md`, or copy this directory and point
  `frontend-profile.json`'s `assistant` elsewhere. The tools described in the persona must match
  what the client actually registers.
- **Add / remove playback tools**: code changes belong in the client — register and execute them in
  the client repo
  [VoiceAgent-MoeKoeMusic-Mobile](https://github.com/juhayna-zh/VoiceAgent-MoeKoeMusic-Mobile)
  (`client.tools` in `session.hello`) and update the persona accordingly; no backend change is
  needed. A different player must implement the GCP tool registration/request/result contract;
  its music API and tool schemas remain implementation-specific, not plug-and-play.
  For server-side tools, see the public [frontend MCP interface](../../docs/reference/frontend-mcp.md).
- **Change the voice model**: set `QWEN_AUDIO_REALTIME_MODEL` in `.env` (available models in
  [model catalog](../../shared/realtime-model-catalog.mjs)). The launcher fixes the provider to
  DashScope; another provider requires adapting the launcher and validating audio/tool support.
- **Restore the default Gateway (no music persona)**: run `npm start` at the repository root without
  this launcher, removing `QWEN_AUDIO_FRONTEND_PROFILE` from any shell/repository/user setting
  that still selects the music profile. Shared memory and other settings remain unchanged.

## Authors and acknowledgements

- [juhayna-zh (Haina Zhu)](https://github.com/juhayna-zh): Gateway example, music companion
  persona, and mobile client tool integration.
- Upstream player: [MoeKoeMusic/MoeKoeMusic-Mobile](https://github.com/MoeKoeMusic/MoeKoeMusic-Mobile),
  with origins in [MoeKoeMusic](https://github.com/iAJue/MoeKoeMusic).
- The separate [VoiceAgent-MoeKoeMusic-Mobile](https://github.com/juhayna-zh/VoiceAgent-MoeKoeMusic-Mobile)
  client builds on that player. It includes a [GPL-2.0 license](https://github.com/juhayna-zh/VoiceAgent-MoeKoeMusic-Mobile/blob/master/LICENSE)
  and declares `GPL-2.0-only` in its package metadata. Consult each repository's license and
  attribution notices when reusing its code; the external client's code is not bundled here.
