[All digital human options](../README.md)

# DHAV Mock / FlashHead guide

[English](dhav.md) | [中文](dhav.zh.md)

A runnable voice + avatar demo on top of the qwen-audio-agent Gateway. The
Realtime model still does the understanding and the talking; a replaceable DHAV
renderer consumes the reply audio and produces a talking avatar, which reaches
the browser over a WebRTC `recvonly` video track. The product `web/` app is not
involved: this example ships its own SPA, served by the Gateway from `/skins`.

## Demo

**Natural conversation, brought to life.** Realtime voice conversation with
audio-driven lip movements and facial expressions.

https://github.com/user-attachments/assets/5301ef5e-b674-4561-93bb-e0c7544cf696

[Digital human demo](../assets/digital-human-demo.mp4)

Two ways to run the demo:

1. **Mock renderer** — any machine, no GPU. An audio-reactive spectrum stands in
   for the avatar, but every other layer (Realtime voice, WebRTC negotiation,
   DHAV protocol, A/V pairing, playback receipts) is real.
2. **Self-deployed FlashHead renderer** — a real talking head on a GPU host.
   §3.3 covers the deployment; afterwards you have a FlashHead API endpoint to
   point this example at.

Voice always uses the real Realtime upstream (DashScope), so an API key is
required in both modes.

```
browser SPA (/skins/digital-human)
   │  WebRTC: mic up, audio + avatar video down
   ▼
Gateway (this repo)  ──WSS──►  DashScope Realtime (ASR/LLM/TTS)
   │  DHAV over HTTP/WS
   ▼
renderer: local Mock  |  your FlashHead service (GPU)
```

## 1. Prerequisites

- Node.js >= 22.22.2.
- The repository installed at the root (`npm install`). The example's SPA has no
  manifest of its own: `react` and `vite` resolve upward from the root
  `node_modules`, so a root install is enough to build it.
- The native WebRTC extension plus this example's own dependency (`ws`):

  ```bash
  npm run example:digital-human:install     # from the repo root
  ```

- A DashScope key. Copy the example env file and fill it in (`.env.local` is
  gitignored and must never be committed):

  ```bash
  cd examples/digital-human
  cp .env.example .env.local                # then set DASHSCOPE_API_KEY
  ```

- The built avatar SPA. `start.mjs` refuses to boot without it:

  ```bash
  npm run build:client                      # -> examples/digital-human/skins/digital-human/
  ```

Configuration reference (see `.env.example`). Everything except
`DASHSCOPE_API_KEY` is optional in Mock mode; `DH_RENDERER_TOKEN` becomes
required as soon as `DH_RENDERER_URL` points at a remote renderer.

| Variable | Default | Meaning |
|---|---|---|
| `DASHSCOPE_API_KEY` | — | Realtime upstream credential. Required. |
| `DH_GATEWAY_HOST` / `DH_GATEWAY_PORT` | `127.0.0.1` / `18895` | Where the demo Gateway listens. |
| `DH_RENDERER_URL` | empty | Renderer base URL. Empty means `start.mjs` launches the local Mock. |
| `DH_RENDERER_TOKEN` | empty | Bearer token for a remote renderer control plane. **Required whenever `DH_RENDERER_URL` is set**: session creation otherwise fails with 401 and the turn silently degrades to audio only. Ignored by the local Mock. Never logged. |
| `DH_PERSONA` | `mock-default` | Startup persona; must be in the server allowlist. The local Mock only knows `mock-default`; a remote FlashHead renderer uses `flashhead-default`. A persona the renderer does not know is rejected with 400 at session creation. |
| `DH_MOCK_FAULT` | empty | Mock fault injection (see §2). |
| `DH_MOCK_RENDERER_HOST` / `DH_MOCK_RENDERER_PORT` | `127.0.0.1` / `0` | Mock listener (local Mock mode only). |
| `QWEN_AUDIO_REALTIME_VOICE` | provider default | Avatar timbre. Read by the framework's Realtime provider resolution rather than by `bootstrap/env.mjs`, so it reaches the process through `.env.local`. Audio-model voices: `longanqian`, `longanlingxin`, `longanlingxi`, `longanxiaoxin`, `longanlufeng`. Leave the line out entirely to keep the default — an empty value means "explicitly cleared" to the framework. |
| `QWEN_AUDIO_REALTIME_MODEL` | `qwen-audio-3.0-realtime-plus` | Realtime model. `compose-gateway.mjs` assigns it with `\|\|=`, so a value in `.env.local` wins. |

## 2. Run with the Mock renderer

From the example directory:

```bash
npm start
```

or from the repo root:

```bash
npm run example:digital-human
```

Because `DH_RENDERER_URL` is empty, `start.mjs` starts the local Mock renderer
on a random port, runs preflight, then boots the Gateway with the avatar video
downlink enabled. Expected output:

```
[start] Mock renderer listening on http://127.0.0.1:5xxxx
[preflight] webrtc_extension: ok
[preflight] gateway_port: ok
[preflight] renderer_ready: ok
[start] Gateway ready at http://127.0.0.1:18895
[start] Open http://127.0.0.1:18895/skins/digital-human/index.html?persona=mock-default in a browser, allow the microphone, and speak.
```

Open the printed URL, allow the microphone, and speak — or type a sentence into
the composer under the avatar and press Enter. You should see:

- the avatar stage paint video frames (the Mock renders an audio-reactive
  spectrum), with the status dot walking
  `待命 → 正在听 → 正在处理 → 正在说话 → 待命`;
- the assistant transcript appear in the panel below while the avatar speaks;
- a barge-in works: interrupt the avatar mid-sentence and it stops instead of
  finishing the old reply.

The Mock renderer is also a fault-injection harness for the degradation paths:

```bash
npm start -- --fault=first_media_timeout
```

| `--fault=` | What you should observe |
|---|---|
| `first_media_timeout` | Renderer admits audio but never publishes media; after the first-media timeout the session degrades to audio-only: you hear the reply, the stage shows `仅音频（头像降级）`, and no video frames are painted. |
| `media_stall` | Media stops mid-turn; the stall watchdog degrades or cancels the turn. |
| `protocol_error` | Renderer speaks a broken DHAV frame; the turn is cancelled, the connection survives. |
| `mid_turn_failure` | Renderer dies mid-turn; the turn degrades, later turns recover. |
| `channel_drop` | The media channel drops; the session rebuilds with a new generation. |

In every case an avatar failure must degrade to audio-only and must never tear
down the voice connection.

## 3. Run with a self-deployed FlashHead renderer

This section assumes you already have a DHAV-compatible FlashHead service
reachable over HTTP/WS (for example the OpenAvatarChat FlashHead Avatar
processor running SoulX-FlashHead Lite on a GPU host). Deploying that service
is covered in §3.3.

### 3.1 What the renderer must provide

The provider (`providers/dhav-provider.mjs`) speaks DHAV against:

| Endpoint | Purpose |
|---|---|
| `GET /health/ready` | Startup preflight probe. Must return 2xx before the Gateway boots. |
| `POST /v1/avatar/sessions` | Create an avatar session; accepts `Authorization: Bearer <DH_RENDERER_TOKEN>` when configured. Returns the session id plus a scoped, short-lived media channel URL and token. |
| `WS <session.input.url>` | The private media channel: PCM audio in, DHAV A/V units out. Authenticated with the scoped token from session creation, not the outer bearer token. |
| `DELETE /v1/avatar/sessions/<id>` | Teardown. |

### 3.2 Configure and start

Put the renderer address and token in `examples/digital-human/.env.local`:

```bash
DH_RENDERER_URL=http://<gpu-host>:<port>
DH_RENDERER_TOKEN=<bearer token>
DH_PERSONA=flashhead-default
```

then:

```bash
npm start
```

or pass them per-run without touching the env file:

```bash
npm start -- --renderer=http://<gpu-host>:<port> --persona=flashhead-default
```

`flashhead-default` is the real-renderer persona in the server allowlist
(`mock-default` stays available for the Mock). The Gateway prints the same demo
URL as in §2; open it with `?persona=flashhead-default`. The SPA resolves the
persona from the server allowlist: an unlisted `?persona=` is not used, and the
page shows a notice explaining the substitution instead of failing silently.

Preflight fails fast with `renderer_unreachable` / `renderer_not_ready` if the
service is down, so a bad address never turns into a hung browser session.

### 3.3 Deploying the FlashHead renderer

The renderer side lives in its own repository, which also carries the full
deployment tutorial and is the source of truth for everything renderer-side:

> <https://github.com/juhayna-zh/OpenAvatarChat> — an adapted OpenAvatarChat
> that exposes a self-deployable, DHAV-compatible digital-human API for this
> example (FlashHead rendering, DHAV v1, Bearer-token auth, port 18910).

In short, on the GPU host:

```bash
git clone https://github.com/juhayna-zh/OpenAvatarChat && cd OpenAvatarChat
uv run install.py                                   # dependencies and CUDA environment
.venv/bin/python scripts/download_models.py         # SoulX-FlashHead Lite weights
openssl rand -hex 32 > ~/.config/dhav-bridge/token  # the bearer token, generated once
DHAV_AUTH_TOKEN=$(cat ~/.config/dhav-bridge/token) \
  .venv/bin/python src/demo.py --config config/chat_with_flashhead_passthrough.yaml --host 127.0.0.1
```

The service then listens on `:18910`; point this example at it with
`DH_RENDERER_URL=http://<gpu-host>:18910` and `DH_RENDERER_TOKEN` set to the same
token you generated. Follow that repository's README for GPU/driver
prerequisites, weight licensing and anything beyond a single-host setup.

Two contract details must stay in sync between the two repositories:

- **Readiness path.** This example's preflight probes `GET /health/ready`
  (`bootstrap/preflight.mjs`), while the renderer README documents
  `GET /readiness`. Expose both on the bridge, or align `checkRendererReady`
  with the renderer, before the first run — otherwise preflight stops the demo
  with `renderer_not_ready`.
- **Token names.** The renderer reads `DHAV_AUTH_TOKEN`; this example sends
  `DH_RENDERER_TOKEN`. Same secret, two names: generate it once and put it in
  both places. Never commit either copy.

### 3.4 Network and security notes

- The FlashHead transport is plaintext HTTP/WS. If the GPU host sits in a cloud
  security group, restrict the source to your fixed egress IP; never open it to
  `0.0.0.0/0`.
- Renderer address and persona come only from server-side startup
  configuration. A browser cannot point the Gateway at an arbitrary renderer or
  persona; unknown personas are rejected with `avatar_persona`, not silently
  downgraded.
- `DH_RENDERER_TOKEN` is read from `.env.local` only, is sent solely as the
  `Authorization` header to the renderer, and is never written to logs, docs or
  commits.

## 4. Tests

```bash
npm test                                # in the example: unit + contract tests, no GPU, no network
npm run test:digital-human              # same suite, from the repo root
npm run test:digital-human-browser      # headless-Chromium end-to-end smoke
```

The browser smoke drives the real Realtime upstream through the built SPA with
only the renderer mocked, so it needs `DASHSCOPE_API_KEY` and a built
`skins/digital-human/`. Deterministic coverage (codec, scheduler, output
selector, orchestrator, presentation hooks) lives in the non-browser suites.

## 5. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `skins/digital-human not found; run \`npm run build:client\` first` | The SPA was never built. Run `npm run build:client`. |
| `DASHSCOPE_API_KEY is required` | Missing key. Set it in `examples/digital-human/.env.local` or the repo-root `.env.local`. |
| preflight `webrtc_extension_missing` | The native WebRTC package is not installed. Run `npm run example:digital-human:install`. |
| preflight `port_in_use` | Another Gateway on `:18895`. Stop it, or use `--port=` / `DH_GATEWAY_PORT`. |
| preflight `renderer_unreachable` | Renderer down, wrong address, or a cloud security group blocking your egress IP. Check §3.4. |
| Browser notice `Gateway 未启用数字人…` | The Gateway started without a renderer or with an empty persona allowlist. |
| `400 avatar_persona` on the offer | The requested persona is not in the server allowlist. Use `mock-default` or `flashhead-default`. |
| `400 avatar_conflict` | Camera input and avatar output cannot be combined in this preview; the dual-video m-line association is unverified. |
| Avatar video stays black until you click | Browser autoplay policy. Click the page once; the SPA surfaces this as an error hint. |
| Voice works but no avatar, status shows `仅音频（头像降级）` | The renderer failed to publish first media in time. Expected under `--fault=first_media_timeout`; otherwise check the renderer logs. |

## 6. Design documents

The runnable demo implements the proposals in this directory:

1. [Architecture and scope](design.zh.md)
2. [Provider contract and concrete mappings](provider-contract.zh.md)
3. [OpenAvatarChat implementation plan and acceptance](implementation-plan.zh.md)

Other design files here are historical context and are superseded by that set.
