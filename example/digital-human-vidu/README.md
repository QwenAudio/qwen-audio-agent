# Vidu digital human

[中文说明](README_ZH.md)

A standalone desktop overlay and browser presentation client for an existing Qwen Audio Agent Gateway. The Gateway handles speech, conversation and configured backend/tools; Vidu S2 Avatar Component Edition renders the character and returns audio/video over Alibaba Cloud ARTC. The microphone goes only to the Gateway. The browser never publishes microphone/camera media to ARTC.

Run this example from a **source checkout**. Its package manifest and launch scripts are in this directory; the client imports the repository's shared Gateway SDK and web audio utilities.

## Demo video

<video src="assets/digital_human_demo_vidu.mp4" controls width="100%"></video>

[Watch or download the demo video](assets/digital_human_demo_vidu.mp4)

## API access and configuration

### Get a Vidu API key

1. Register or sign in at the [Vidu China API platform](https://platform.vidu.cn/) using **开始接入**, or use the [international platform](https://platform.vidu.com/).
2. Create a key under **API Key 管理 / API Keys**, copy the complete `vda_...` value and set `VIDU_API_KEY` below. Add usage credits through the account billing/recharge page. See the official [China API quickstart](https://platform.vidu.cn/docs/quick-start) or [international API quickstart](https://platform.vidu.com/docs/quick-start).
3. Confirm that your account has access to S2 Avatar Component Edition and enough credits. If the endpoint reports insufficient permissions, ask Vidu to confirm service access.

Use the API host matching the platform where the key was issued:

| Key platform | `VIDU_HOST` |
| --- | --- |
| [China](https://platform.vidu.cn/) | `api.vidu.cn` (default) |
| [International](https://platform.vidu.com/) | `api.vidu.com` |

The official [S2 Avatar realtime quickstart](https://platform.vidu.cn/vidu-stream/doc/s2-avatar/realtime/quick-start) covers Realtime Edition and environment selection. This example uses the [Component Edition protocol](https://platform.vidu.com/vidu-stream/doc/s2-avatar/component/parameters) at `/live/s_avatar/component`, with assistant audio supplied by the Gateway and your own ARTC application. Follow this README's installation and launch commands below.

### Get an ARTC AppID and AppKey

1. Register and verify an Alibaba Cloud account, then activate ApsaraVideo Live following the official [application creation guide](https://help.aliyun.com/zh/live/activate-application).
2. In the [ApsaraVideo Live console](https://live.console.aliyun.com/), open **直播+ → 实时音视频 → 应用管理** and create a real-time audio/video application.
3. Open the application's **管理 → 基本信息** and copy its AppID and AppKey into `ARTC_APP_ID` and `ARTC_APP_KEY`. Both must belong to the same application. These are application credentials, distinct from your Alibaba Cloud account AccessKey ID/Secret.

Use [ARTC token authentication](https://help.aliyun.com/en/ims/developer-reference/token-based-authentication). The local server creates channel/user IDs and short-lived tokens using these credentials; you do not need to configure a manual RTC token. The AppKey stays on the server; the browser receives join credentials only.

### Configure the local environment file

For first-time setup, copy the template in `example/digital-human-vidu`. If `.env.local` already exists, edit that file instead:

```sh
cp .env.example .env.local
```

Replace the placeholder values in `.env.local` with your credentials:

```dotenv
VIDU_API_KEY=vda_your_vidu_api_key
ARTC_APP_ID=your_artc_app_id
ARTC_APP_KEY=your_artc_app_key
VIDU_HOST=api.vidu.cn

# Optional: attach to an existing local Gateway
# VIDU_GATEWAY_ORIGIN=http://127.0.0.1:3101
```

Enter the plain `vda_...` value; the server adds the HTTP `Token` prefix. All three credentials are required: the Vidu key creates the avatar live, and ARTC credentials deliver audio/video. Configure the voice provider and tools separately using the Gateway quickstart below. `.env.local` is Git-ignored; keep credentials out of client code.

Both `npm run desktop:vidu` and `npm run dev` read this directory's `.env.local`; existing shell environment variables take precedence. After editing, stop and restart the example, including the entire floating-window application. If it attaches to an existing browser server, restart that server too.

### Check configuration and troubleshoot

Once running, check local configuration from a terminal:

```sh
curl http://127.0.0.1:5181/vidu/api/config
```

`configured: true` confirms that the three values are present and the key format passes the local check. It does not validate Vidu permissions/credits or ARTC credentials. Click **开始对话** to verify moving video and audible replies.

| Symptom | What to check |
| --- | --- |
| Missing Vidu key notice or `configured: false` | Check all three credentials in this directory's `.env.local`, the `vda_` prefix and any shell overrides; restart the runtime. |
| Vidu returns 401 / 403 | Check key validity, matching `VIDU_HOST`, Component Edition access and account credits. |
| ARTC join/token authentication fails | Confirm the full AppID/AppKey belong to the same enabled application, check the system clock, then end and restart the conversation for fresh tokens. |
| ARTC SDK fails to load | Check access to the official SDK CDN; the page requires network access. |
| Video works but replies are silent | Check that the Gateway provider produces assistant PCM, allow browser audio playback and inspect remote track diagnostics in settings. |

## Run

Install the repository dependencies with `npm ci` at the repository root. Configure a supported realtime provider and backend using the [Qwen Audio Agent quickstart](../../docs/getting-started/quickstart.md). The example discovers the orb's running Gateway or starts one with the same configuration/state paths. You can also start `npm start` separately and set `VIDU_GATEWAY_ORIGIN` to attach to that Gateway.

In another terminal, from the repository root:

```sh
cd example/digital-human-vidu
npm ci
# Prepare .env.local using "API access and configuration" above.
npm run desktop:vidu
```

An always-on-top Vidu window opens at the bottom-right of the screen. Drag the empty area at the top or the center of the video to move it; the top remains draggable while settings are open. Click ⚙, use the prefilled default sample image, provide a single-person character image URL, or upload a PNG/JPEG/WebP file (up to 4 MB; an uploaded file takes priority, and an empty URL falls back to the default image). Click **开始对话**, allow microphone access, then speak. For text chat, open the browser page at `http://127.0.0.1:5181`. Click **结束对话** before stopping the example with Ctrl-C.

## Choose a UI

From this directory, `npm run desktop:vidu` (or `npm run desktop`) starts the Vidu floating window; `npm run desktop:orb` starts the original Qwen Audio Agent orb unchanged. `npm run dev` starts the browser version at `http://127.0.0.1:5181`. The floating window's settings include **切换到悬浮球**: it ends the avatar conversation, closes its owned runtime, and opens the stock orb.

The two UIs share Gateway configuration, provider, backend/tools and persistent state; they have separate window preferences and conversation sessions. Choose one active microphone UI at a time. End/quit the orb before starting an avatar conversation. Wake-word and auto-hide features are available in the stock orb. Configure voice/tools through the stock orb's settings; restart the Vidu runtime to load changes.

A running Gateway is borrowed and remains running when the Vidu host exits. If no matching desktop lease exists, the Vidu host starts a Gateway using the existing shared process manager and stops it on exit. If the browser example already owns the Vidu server, the floating window attaches and leaves that server running on quit.

`VIDU_GATEWAY_ORIGIN` optionally selects a specific local HTTP Gateway origin. This development example uses ports 5181/5182 and accepts browser requests from `http://127.0.0.1:5181`; use that exact URL. `VIDU_HOST` accepts `api.vidu.cn` or `api.vidu.com`. Secrets are read from the environment or `.env.local` only, never bundled in browser assets. Keep the ARTC application configured for token authentication.

Starting a conversation initializes a Vidu live and **can incur Vidu/ARTC charges**. It creates a fresh Gateway conversation ID and a new RTC channel each time. Gateway disconnect, initialization timeout, live hangup and Ctrl-C close the control link. Unconnected local session handles expire after one minute; active sessions close after two hours, before their RTC credentials expire. Token renewal and remote deployment are outside this example.

## Integration boundary

```text
Microphone / text
       ↓
Gateway SDK → Gateway (voice / conversation / tools)
       ↓ assistant PCM / transcript / interruption
Local Vidu WebSocket proxy
       ↓
Vidu S2 component → ARTC → browser audio / video
```

Assistant audio is converted to mono 24 kHz signed 16-bit little-endian PCM and sent as binary WebSocket frames. Final assistant transcripts use Vidu `output_transcription` (type 10). Interruption resets the streaming resampler and sends type 7; hangup uses type 5. `NOT_READY` retries initialization on the same socket. Text is supplementary signaling, not a Vidu TTS request. The selected Gateway provider must produce assistant PCM for the character to speak.

Audible output comes from ARTC only. A silent local PCM clock estimates Gateway playback started/ended receipts; these receipts do **not** measure remote rendering/playback latency. The example does not offer frame-accurate sync or Vidu action/expression commands. If browser autoplay blocks audio, permit sound for this site and restart. Remote track/subscription diagnostics are available in settings.

Backend/tool execution stays in the Gateway. This page does not advertise browser tools or implement the full task/approval console. Handle permission requests and requests for additional input in the standard Gateway WebUI. The example shows a notice when such a request arrives.

## Validate

```sh
npm test
npm run build
```

Tests use mock HTTP/WebSocket services to validate RTC signing, secret isolation, audio/text/interrupt/hangup signaling, initialization retry/timeout, origin validation, input limits, cancellation, expiration and shutdown. `npm run build` checks browser imports; its output is not a standalone deployment (Gateway/API/WebSocket proxies are still needed).

These checks do not validate a paid Vidu session or prove that ARTC returns audible speech. Live acceptance: start one conversation, verify moving video and audible replies, interrupt while speaking, exercise a configured tool, end the conversation, then start again and verify a fresh transcript. Check that the live ends in the Vidu console.

Protocol references: [Vidu Component Edition](https://platform.vidu.com/vidu-stream/doc/s2-avatar/component/parameters), [ARTC token authentication](https://help.aliyun.com/en/ims/developer-reference/token-based-authentication). The page loads the pinned Alibaba ARTC Web SDK 7.1.9 from the official CDN; that SDK requires internet access and is not vendored here.
