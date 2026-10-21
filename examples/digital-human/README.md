# Digital Human Example

English | [中文](README_ZH.md)

Digital human presentations for Qwen Audio Agent: DHAV Mock/FlashHead and Vidu S2
Avatar Component Edition. The Realtime provider handles speech and conversation;
the avatar service renders the character. Code, configuration templates and demo
videos for both paths live here. Choose one path to run.

## Core capabilities

| Path | Implemented capabilities | Guide |
| --- | --- | --- |
| DHAV Mock | GPU-free audio spectrum video with real speech, WebRTC and A/V scheduling | [Run guide](docs/dhav.md) |
| DHAV FlashHead | Self-hosted GPU renderer, browser audio/video, interruption and audio fallback | [Deployment](docs/dhav.md) |
| Vidu / ARTC | Cloud rendering, default/custom image, browser and draggable desktop overlay, switch to stock orb | [Vidu guide](vidu/README.md) |

### Demo videos

Existing digital human demo, retained alongside the DHAV/FlashHead guide:

https://github.com/user-attachments/assets/5301ef5e-b674-4561-93bb-e0c7544cf696

[Watch or download the digital human demo](assets/digital-human-demo.mp4)

Vidu desktop avatar:

<video src="assets/digital_human_demo_vidu.mp4" controls width="100%"></video>

[Watch or download the Vidu demo](assets/digital_human_demo_vidu.mp4)

Demo footage illustrates interaction; automated checks validate code separately.
Neither proves live-service acceptance on the current machine.

## Architecture and boundaries

| Boundary | DHAV Mock / FlashHead | Vidu / ARTC |
| --- | --- | --- |
| Audio to renderer | Gateway presentation layer → DHAV provider | Browser Gateway SDK → local Vidu proxy |
| Media return | Timestamped paired PCM/I420 → Gateway media worker → WebRTC | Vidu → ARTC → browser SDK |
| UI | `client/` SPA served at Gateway `/skins/digital-human` | `vidu/client/` browser and Electron overlay |
| Gateway lifecycle | `bootstrap/` starts an isolated example Gateway | `vidu/gateway-host.mjs` borrows or starts the desktop Gateway; stops only its own process |
| Configuration/state | `.env.local`, `.runtime/` here | `vidu/.env.local`, `vidu/.desktop/`; Gateway state shared with the orb |

DHAV uses the framework's existing `digitalHuman` injection, WebRTC video output
and media scheduler. Vidu uses the Gateway Client SDK and an independent ARTC
downlink. The transports remain separate; adding Vidu requires no further core
changes. See the [architecture analysis (Chinese)](docs/integration-architecture.zh.md)
for the reasoning, synchronization boundaries and future integration requirements.

## Quick start

Run from a source checkout with Node.js >= 22.22.2. First run `npm ci` at the
repository root.

### DHAV Mock / FlashHead

Start these commands at the repository root:

```sh
npm run example:digital-human:install
cd examples/digital-human
cp .env.example .env.local
# Set DASHSCOPE_API_KEY. FlashHead also needs renderer URL, token and persona.
npm run build:client
npm start
```

Open the printed `http://127.0.0.1:18895/skins/digital-human/index.html?...` URL,
click the microphone, allow recording and speak. Verify replies, video and text;
text input also triggers replies. Mock needs no GPU but still uses a real voice
provider key. FlashHead requires a separately deployed GPU service; follow the
[full guide](docs/dhav.md). Ctrl-C stops the Gateway and owned local Mock.

### Vidu / ARTC

Run in `examples/digital-human`:

```sh
npm run vidu:install
cp vidu/.env.example vidu/.env.local
# Set VIDU_API_KEY, ARTC_APP_ID and ARTC_APP_KEY; configure Gateway voice/tools.
npm run start:vidu
```

Choose an image in overlay settings, click **开始对话**, allow the microphone and
speak. Verify moving video and audible replies. Click **结束对话** before quitting.
The overlay has been checked on macOS; other desktop platforms need local
acceptance. Vidu API access, ARTC and the online SDK are prerequisites; starting a
conversation can incur charges. See [API access and configuration](vidu/README.md#api-access-and-configuration).
Edit existing environment files instead of copying the template again.

| Command in this directory | Purpose |
| --- | --- |
| `npm start` | DHAV Mock, or remote FlashHead when `DH_RENDERER_URL` is configured |
| `npm run start:vidu` | Vidu desktop overlay |
| `npm run dev:vidu` | Vidu browser at `http://127.0.0.1:5181` |
| `npm run start:orb` | Stock orb; also available through Vidu overlay settings |

Use one microphone UI at a time. These are separate presentation paths, without
seamless renderer switching inside an active conversation.

## Configuration and data

- DHAV defaults to local port `18895`; see [.env.example](.env.example). Shell
  variables override this directory's `.env.local`. Only a missing voice key is
  read from the repository-root `.env.local`. Isolated state lives in `.runtime/`.
  The renderer receives assistant audio; microphone audio goes to the Gateway
  and the voice upstream.
- Vidu defaults to ports `5181/5182`; see [vidu/.env.example](vidu/.env.example).
  Shell variables override `vidu/.env.local`. Assistant audio/text and the image
  go to Vidu; ARTC returns media. The microphone goes only to the Gateway. Vidu
  keys, ARTC AppKey and control secrets stay in the local server.
- Vidu shares the orb's voice/tool configuration and persistent Gateway state,
  with separate window state. Restart the relevant runtime after environment
  changes. Removing `vidu/.desktop/` resets overlay state, not Gateway history.
- Environment files, `.runtime/` and `vidu/.desktop/` are ignored. After exiting
  the relevant processes, manually remove that mode's environment/state files to
  reset it. Remote retention follows the services' policies; local deletion does
  not delete remote data.

See the [DHAV guide](docs/dhav.md) and [Vidu guide](vidu/README.md) for parameters,
authentication and troubleshooting.

## Validation and limitations

After installing both paths' dependencies, run here:

```sh
npm run test:all
npm run build:client
npm run build:vidu
```

`npm test` covers DHAV only; `npm run test:vidu` covers Vidu only. Mock/protocol
checks need neither a GPU nor live Vidu calls. The DHAV browser smoke command
`npm run test:digital-human-browser` (repository root) requires a real voice key
and the native WebRTC extension; see the run guide.

DHAV schedules media against the worker's audio clock and can fall back to audio;
camera input and avatar output cannot currently be enabled together. Vidu
estimates Gateway playback receipts with a silent PCM clock, does not measure
actual ARTC playback and does not use DHAV's audio fallback. Tokens are not
renewed automatically; active sessions last at most two hours. Use the standard
Gateway WebUI for tool approvals and additional input. Live FlashHead/Vidu video,
speech, interruption, tools and shutdown still need manual acceptance with the
external services configured.

## Replacement and extension

- Replace the DHAV renderer through `DH_RENDERER_URL`, `DH_RENDERER_TOKEN` and
  `DH_PERSONA`; the service must satisfy the [provider contract (Chinese)](docs/provider-contract.zh.md).
  Clear the remote URL to restore local Mock.
- Select Vidu China/international service using matching `VIDU_HOST` and API key
  in `vidu/.env.local`. Change the image in settings; voice/tools use Gateway configuration.
- Vidu cannot directly implement the existing DHAV media contract. Sharing the
  media worker would first require server-side RTC reception and paired PCM/I420
  with turn/generation metadata, followed by synchronization/fallback validation.

## Authors and acknowledgements

- [Haina Zhu / juhayna-zh](https://github.com/juhayna-zh): DHAV, Mock/FlashHead,
  WebRTC presentation and client in [PR #562](https://github.com/QwenAudio/qwen-audio-agent/pull/562).
- [zzasdf](https://github.com/zzasdf): Vidu/ARTC browser, desktop overlay and demo
  footage in [PR #548](https://github.com/QwenAudio/qwen-audio-agent/pull/548).
- Services/dependencies: [Vidu](https://platform.vidu.cn/), [Alibaba Cloud ARTC](https://help.aliyun.com/zh/live/activate-application),
  [OpenAvatarChat FlashHead service](https://github.com/juhayna-zh/OpenAvatarChat).
  Their service, model and asset licenses apply; this example does not imply official endorsement.
