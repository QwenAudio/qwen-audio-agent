# Digital-human client example

English | [中文](README_ZH.md)

A local client that connects to both **qwen-audio-agent Gateway** and an **avatar service**, demonstrating replaceable digital-human presentation without vendor-specific framework changes. Gateway handles real-time conversation, tools and background tasks. The avatar service consumes the assistant's generated reply audio to animate the character and provide sound, without a separate ASR / LLM / TTS pipeline.

The same example integrates self-hosted [OpenAvatarChat / FlashHead](https://github.com/juhayna-zh/OpenAvatarChat) through DHAV and commercial [Vidu](https://platform.vidu.cn/) / ARTC. This is an optional example, not a built-in avatar feature of the standard WebUI or desktop app.

## Core capabilities

| Integration | What you can try | Playback capability |
| --- | --- | --- |
| DHAV Mock (default) | GPU-free synthetic visuals for testing voice/text conversation and interruption | Actual playback start, drain and cancellation receipts |
| Self-hosted DHAV / FlashHead | Connect the same client to a self-hosted avatar service | Actual playback start, drain and cancellation receipts |
| Commercial Vidu / ARTC (experimental) | Choose a character image and use native vendor audio/video; requires an account, credit and explicit opt-in | Local interruption and stale-media isolation; no per-reply playback receipts |

The browser and optional Electron window share conversation, captions, microphone controls and renderer adapters. Mock simulates only the avatar visuals; normal conversation still calls the model configured in Gateway.

### Self-hosted DHAV / FlashHead demo

Avatar conversation footage provided by the original author.

https://github.com/user-attachments/assets/5301ef5e-b674-4561-93bb-e0c7544cf696

### Commercial Vidu / ARTC demo

The contributor's original-version demonstration shows the avatar appearance and floating-window interaction. It is not a real-service acceptance record for the current revision.

https://github.com/user-attachments/assets/dc9296b5-dfbe-4243-a2c6-3bf49237d71b

## Architecture and boundaries

| Component | Responsibilities and interfaces | Lifecycle |
| --- | --- | --- |
| Standard Gateway | Provides conversation, tools, background tasks and assistant PCM through [GCP and the public client SDK](../../docs/gateway-protocol.md) | Started and stopped independently by the user |
| This example: browser + local Node host | `/gateway` proxies standard GCP; `/avatar` forwards assistant audio, renderer controls and media credentials; the browser plays avatar audio/video | Start with `npm start`, stop with `Ctrl+C`; automatically manages Mock by default |
| Avatar service | DHAV returns paired audio/video frames; Vidu returns native ARTC audio/video | Self-hosted services are managed by their deployer; the example creates and releases Vidu sessions |

The browser establishes two independent connections through the local host. Shared orchestration is in [useDualConnection.js](client/useDualConnection.js), and the proxy entry point is [server.mjs](server/server.mjs). The local host is not a second Gateway and does not store a separate conversation history.

Vendor protocols, SDKs and playback implementations stay inside the example; `qwen-audio-agent-rtc` is not required. Gateway reuses generic playback-capability negotiation: clients with real receipts report actual playback. When receipts are unavailable, Gateway advances only generation-side state, without treating generation completion as proof that the user heard the reply.

## Quick start

Prerequisites: a framework-supported Node.js version (22.22.2 or 24.15.0 recommended), npm 10+, a working Realtime model configuration, and a modern browser with audio playback and microphone permission. The commands below start from this repository's source checkout. The default Mock needs neither a GPU nor an avatar-service account. Browser automation uses Chromium; real avatar services have additional GPU, account and platform requirements.

**Vidu requires a Gateway containing the generic receipt-less fallback (`761672f` or later). Until a compatible version is released, use the latest `main` source. Updating only the example or SDK while keeping an older Gateway is insufficient.**

### 1. Start the standard Gateway

In terminal one, run from the repository root. Skip `config` if your model is already configured:

```bash
npm ci
node cli/bin/qwenaudio.mjs config
npm run build
npm start -- --backend none
```

Configure model credentials and the voice frontend through the [framework quick start](../../docs/getting-started/quickstart.md), not this example. `--backend none` validates conversation first; configure a backend through the framework when you need background tasks. Make sure an older Gateway is not occupying the port, and disconnect other WebUI, desktop or TUI clients for the same user.

### 2. Start the example client

In terminal two, enter the example directory from the repository root:

```bash
cd examples/digital-human
npm ci
cp .env.example .env.local
npm run build:client
npm start
```

In Windows PowerShell, replace the copy command with `Copy-Item .env.example .env.local`. To change the Gateway address or renderer service, edit `.env.local` as described in the next section before starting.

Open the printed address, default `http://127.0.0.1:5273`. Click Connect avatar (连接数字人) to authorize audio playback, then enter “你好，介绍一下你自己” (hello, introduce yourself). You should see reply captions, hear the reply and see the audio-reactive synthetic Mock visuals. Enable the microphone for voice interaction; Vidu mode requests microphone access after connecting.

### 3. Stop and optionally use the floating window

Click End (结束) to release the avatar session, then press `Ctrl+C` in terminal two to stop the example. Gateway keeps running; stop it separately in terminal one when no longer needed. Idle Vidu sessions may incur charges, so end them when not in use.

The optional Electron window opens the same page. In another terminal in the example directory, run:

```bash
npm install --no-save --package-lock=false electron@43.8.1
npm run desktop
```

The window supports dragging and an always-on-top toggle. Closing it does not stop the Node host or Gateway. Use only one microphone client at a time.

## Configuration and data

The configuration template is [.env.example](.env.example). **Shell environment variables take precedence over `.env.local`, followed by code defaults.** Restart the example after changes. The example does not modify your Gateway configuration.

| Setting | Requirement and default |
| --- | --- |
| `DH_GATEWAY_URL` / `DH_GATEWAY_TOKEN` | Default `ws://127.0.0.1:18888/api/realtime`; provide a token when Gateway authentication is enabled |
| `DH_CLIENT_PORT` | Optional, default `5273`; listens only on loopback |
| `DH_RENDERER_ADAPTER` | Default `dhav`; the registered `vidu` adapter is also available |
| `DH_RENDERER_URL` / `DH_RENDERER_TOKEN` | DHAV only; an empty URL starts Mock automatically; self-hosted deployment needs the service URL and any required token |
| `DH_PERSONA` | Default `mock-default`; the self-hosted FlashHead example uses `flashhead-default` |
| `VIDU_EXPERIMENTAL` | Default `0`; set to `1` only after accepting the experimental limitations and charges |
| `VIDU_API_KEY` / `ARTC_APP_ID` / `ARTC_APP_KEY` | Required for Vidu: a valid component API key and the ID/key of the same ARTC application; replace the template's `vda_replace_me` |
| `VIDU_HOST` | Default `api.vidu.cn`; international accounts use `api.vidu.com`, matching the API key |
| `DH_MOCK_FAULT` | Test-only fault injection; leave empty for normal operation; supported values are listed in the template |

See the [adapter contract](docs/provider-contract.zh.md) for self-hosted service requirements and the [Vidu guide](docs/vidu.md) for access, configuration and billing boundaries. The optional window reads `DH_DESKTOP_URL` and `DH_ORB_LAUNCH` from its launching shell, not `.env.local`. The latter is disabled by default and accepts only launch arguments supplied by the local operator.

- **External data:** microphone audio and text go to Gateway and its configured model; the avatar service receives assistant reply audio. Vidu also receives the selected character image or image URL. The browser loads the vendor's ARTC SDK and receives its media.
- **Credentials:** Gateway tokens, Vidu keys and ARTC AppKeys remain in the local Node host. The browser receives only the short-lived RTC credentials needed for playback. Never put long-lived credentials in frontend code or Vite variables.
- **Local state:** `.env.local` stores example configuration. Browser `localStorage` retains the Session ID for reuse after refresh. The example does not separately persist server-side conversation, audio or character-image files; Gateway manages conversation records. Electron settings and cache are stored in `.desktop/`.
- **Cleanup:** after stopping the example, you can remove `.env.local` and `.desktop/` and clear the browser's site data. `dist/` contains rebuildable frontend output. Manage Gateway records separately; deleting local files neither deletes vendor-retained data nor cancels existing charges.

## Validation and limitations

Run from the example directory:

```bash
npm test
npm run build:client
npx playwright install chromium
npm run test:browser
npm run test:browser:vidu
```

Tests and the build should pass. Coverage includes protocol encoding/decoding, connections, cancellation isolation, playback receipts and security boundaries. Browser tests use a fake Gateway, vendor SDK and local media streams, without real model calls or paid services. See the [validation record](docs/presentation-validation.zh.md) and [real-deployment checklist](docs/implementation-plan.zh.md).

- **Assistant reply audio (avatar input):** currently accepts only PCM16 little-endian, 24 kHz, mono. Other sample rates are rejected rather than silently played at the wrong rate. This restriction does not refer to microphone capture.
- **DHAV:** receipts follow actual playback start, drain and cancellation. A failure before first playback may fall back to original audio once; playback never restarts from the beginning after it has started. Deployers must validate real FlashHead GPU performance and audiovisual synchronization.
- **Vidu:** disabled by default; this revision has not completed real-service acceptance. Native audio/video play through the same media element. Interruption immediately stops old local media, and the next valid reply uses a new live / RTC channel, adding reconnection latency and potentially charges.
- **Without playback receipts:** Vidu provides neither per-reply playback-end nor remote interruption-completion confirmation. The example does not estimate or fabricate receipts. Ordinary dialogue can display generated captions; automatic background-result notifications remain pending. Users can actively query tasks by voice or text. This example has no complete task-card or permission-management UI.
- **Failures and scope:** Vidu failures stop microphone capture and require reconnection, without automatic audio replay. Input and queues are bounded. This is a local, single-client integration, not a multi-tenant production service; do not expose the local credential proxy directly to the Internet. Other browsers, long-running sessions and commercial RTC network behavior still need real-environment validation.

## Replacement and extension

- **Self-hosted DHAV:** set `DH_RENDERER_ADAPTER=dhav`, the service URL/token and `DH_PERSONA`. The service must implement session creation/release, input/media WebSockets and DHAV v1 audiovisual frames. See [OpenAvatarChat / FlashHead](https://github.com/juhayna-zh/OpenAvatarChat) for deployment. An arbitrary avatar-service HTTP URL is not sufficient.
- **Commercial Vidu:** set `DH_RENDERER_ADAPTER=vidu`, supply the credentials above and explicitly enable the experimental flag. It uses the same startup commands and page; see the [Vidu guide](docs/vidu.md).
- **New services:** implement authentication, service sessions and audio forwarding in [server/renderers/](server/renderers/), and media playback and capability declarations in [client/renderers/](client/renderers/). Register the same adapter ID in the [server registry](server/renderers/index.mjs) and [browser registry](client/renderer-adapters.mjs). See the [adapter contract](docs/provider-contract.zh.md). Vendor adapter code is required; Gateway changes or conversion of native RTC into DHAV are not.
- **Restore defaults:** set `DH_RENDERER_ADAPTER=dhav`, `DH_PERSONA=mock-default` and `VIDU_EXPERIMENTAL=0`, clear `DH_RENDERER_URL` / `DH_RENDERER_TOKEN`, then restart. Also check for shell variables overriding these settings.

If you copy this directory independently, additionally run `npm install qwen-audio-agent` to obtain the public client SDK before building the page. Gateway must still run separately and meet the revision requirement above.

## Authors and acknowledgements

- [Haina Zhu (@juhayna-zh)](https://github.com/juhayna-zh): original digital-human example, DHAV protocol, Mock renderer, FlashHead integration, character UI and demo footage.
- [@zzasdf](https://github.com/zzasdf): Vidu / ARTC integration, floating desktop window, character-image interaction and demo footage.

Upstream services and dependencies: [OpenAvatarChat / FlashHead](https://github.com/juhayna-zh/OpenAvatarChat), [Vidu](https://platform.vidu.cn/) and [Alibaba Cloud ARTC](https://help.aliyun.com/zh/live/activate-application). Demo assets retain contributor attribution; these references do not imply official endorsement by the service providers.
