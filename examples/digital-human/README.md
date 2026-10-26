# Digital-human client example

[English](README.md) | [中文](README_ZH.md)

A normal qwen-audio-agent client with **two independent connections**: one to the Gateway for conversation, and one to a replaceable avatar renderer. The renderer consumes assistant reply audio; it does not own another ASR / LLM / TTS loop.

No framework runtime, SDK, GCP or framework dependency changes are required. No qwen-audio-agent-rtc installation is required. Run inside this repository or copy this directory and use the official package's public Client SDK with an ordinary Gateway.

## Demo

Original DHAV / FlashHead demonstration; the refactored browser client still requires real GPU deployment validation:

https://github.com/user-attachments/assets/5301ef5e-b674-4561-93bb-e0c7544cf696

## Boundaries

| Connection | Content | Responsibility |
| --- | --- | --- |
| Browser ↔ Gateway | Unmodified GCP: microphone/text, assistant PCM, lifecycle events, playback receipts | Conversation and tasks |
| Browser ↔ renderer adapter | Assistant PCM, render controls, media or short-lived RTC credentials | Avatar presentation |

The example-local Node host proxies GCP unchanged and protects renderer credentials. It is not a custom Gateway.

- Implemented: DHAV adapter, GPU-free synthetic Mock renderer, remote DHAV configuration.
- Vidu preview: an opt-in delayed presentation mirror. Original PCM is scheduled through zero gain and owns Gateway receipts; native RTC media does not affect Agent scheduling. An original-audio comparison mode shares the same source player. Disabled by default; see [scope, setup and limits](docs/vidu.md).
- Supported reply format: PCM16 little-endian, 24 kHz, mono. Other sample rates are rejected rather than misplayed.

## Run

Node.js ≥ 22.22.2. First start an ordinary Gateway with your existing model configuration, for example:

```bash
qwenaudio gateway --backend none
```

Model keys and backend settings belong to Gateway, not this example. The example never starts, changes or stops your Gateway; no example-specific Gateway branch is needed.

Then, in a checkout:

```bash
cd examples/digital-human
npm ci
cp .env.example .env.local
npm run build:client
npm start
```

For a standalone source copy, install the public SDK package before building:

```bash
npm install qwen-audio-agent
```

Open the printed address (default `http://127.0.0.1:5273`), click Connect to authorize audio, then enable the microphone or submit text. An empty `DH_RENDERER_URL` starts a synthetic audio-reactive renderer: no GPU/model download. Normal conversation still calls your configured model; automated tests do not.

## Self-hosted renderer

```dotenv
DH_GATEWAY_URL=ws://127.0.0.1:18888/api/realtime
DH_GATEWAY_TOKEN=
DH_RENDERER_ADAPTER=dhav
DH_RENDERER_URL=http://your-renderer-host:port
DH_RENDERER_TOKEN=your-renderer-token
DH_PERSONA=flashhead-default
```

The renderer exposes DHAV v1 session creation/deletion, authenticated PCM input and paired PCM/I420 media WebSockets. See the original author's [OpenAvatarChat / FlashHead service](https://github.com/juhayna-zh/OpenAvatarChat) for GPU deployment. This refactor preserves its wire protocol; real deployment remains an explicit acceptance step.

## Replace the service

Adapters live entirely in this example:

- `server/renderers/`: long-lived credentials, service sessions, audio forwarding and short-lived media credentials.
- `client/renderers/`: vendor media transport/player and actual playback lifecycle.
- Register the same adapter ID on both sides; select it with `DH_RENDERER_ADAPTER`.

Vidu reuses `useDualConnection` with an independent source PCM timeline and native RTC presentation. See the [Vidu guide](docs/vidu.md).

## Vidu preview and optional overlay

Set `DH_RENDERER_ADAPTER=vidu` and the server credentials in the same `.env.local`; see [Vidu setup](docs/vidu.md). The preview is disabled unless `VIDU_EXPERIMENTAL=1`. Connect creates one session-scoped live/RTC channel, reused across replies and idle video. Idle time can incur Vidu/ARTC charges; End hangs up. Original PCM owns Gateway receipts independently; uploaded RTC media continues across source interruptions.

Vidu does not expose a per-response playback boundary to the Agent. Original PCM is scheduled through zero gain and owns all playback receipts; RTC media is presentation only. No content matching, completion timer or per-turn remote interrupt remains. See the [scope and tradeoffs](docs/vidu.md).

The optional Electron shell opens the same running example page. In another terminal here:

```sh
npm install --no-save --package-lock=false electron@43.7.9
npm run desktop
```

Drag the top bar. The window is not always on top by default; the top-bar button toggles it. Closing the window stops neither the example server nor the Gateway. Shell variable `DH_DESKTOP_URL` selects another loopback HTTP origin. The stock orb remains an independent UI option; use one microphone UI at a time. A switch button is enabled only by a trusted operator's `DH_ORB_LAUNCH` JSON argv array in the shell, e.g. `["npm","run","desktop","--prefix","/path/to/source-checkout"]`; it runs without a shell after local playback stops. The page cannot supply a command.

The [Vidu prototype video](assets/digital_human_demo_vidu.mp4) and [original digital-human footage](assets/digital-human-demo.mp4) remain available. They do not prove acceptance of the migrated integration.

## Delivery semantics

DHAV uses actual paired-media playback for start/drain/cancel receipts and may fall back to original
PCM before its first playback. Its media lifecycle remains separate from source `audio.done`.

Vidu is a delayed presentation side branch. Original model PCM is scheduled through zero gain,
and its own timeline produces Gateway playback receipts. Vidu initialization, returned content,
playback end or failure does not control Agent scheduling. Native RTC audio/video continues
across source completion and interruption; already uploaded content may still play. No per-turn
Vidu interrupt, content matching, completion estimate, extra playback buffer or frame cache remains.
The original-audio comparison checkbox unmutes the same source player and mutes/hides the avatar;
it changes no source schedule or receipt logic. Input-only microphone mute preserves output.

This explicitly differs from the previous review requirement for actual ARTC playback receipts and
immediate stale-media cancellation. Maintainer agreement is required; Vidu stays experimental and
disabled by default. The design does not solve listener/model context mismatch or heard-position
truncation. See the [Vidu guide](docs/vidu.md) and [flow diagrams](docs/audio-processing-flow.zh.md).

## Security and scope

This single-client demo binds to loopback and validates Host / WebSocket Origin. Long-lived Gateway and vendor secrets stay in Node; commercial adapters may deliver short-lived RTC join credentials to the browser. Never put long-lived secrets in frontend bundles.

Remote deployment requires HTTPS, authentication, quotas and an explicit origin policy. Do not expose the local credential relay directly to the Internet.

## Test

```bash
npm test
npm run build:client
npx playwright install chromium
npm run test:browser
npm run test:browser:vidu
```

Tests use a fake Gateway and real local Mock renderer connections, without model calls or paid APIs. See the [deployment checklist](docs/implementation-plan.zh.md) for real-service acceptance.

## Credits

Thanks to [Haina Zhu (@juhayna-zh)](https://github.com/juhayna-zh) for the original example, DHAV protocol, Mock renderer, FlashHead integration and avatar UI, reused here with a client-owned presentation boundary. The commercial renderer seam also draws on @zzasdf's Vidu example design.
