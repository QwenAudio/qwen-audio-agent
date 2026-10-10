# Vidu digital human

[中文说明](README_ZH.md)

A standalone desktop overlay and browser presentation client for an existing Qwen Audio Agent Gateway. The Gateway handles speech, conversation and configured backend/tools; Vidu S2 Avatar Component Edition renders the character and returns audio/video over Alibaba Cloud ARTC. The microphone goes only to the Gateway. The browser never publishes microphone/camera media to ARTC.

All example code, dependencies and scripts live here. No Gateway/provider/desktop changes or `3d-model` dependency are required. Run this example from a **source checkout**; it imports the existing shared Gateway SDK and web audio utilities.

## Run

1. Install the repository dependencies with `npm ci` at the repository root. Configure a supported realtime provider and backend using the normal Qwen Audio Agent setup. The example discovers the orb's running Gateway or starts one with the same configuration/state paths. You can also start `npm start` separately and set `VIDU_GATEWAY_ORIGIN` to attach to that Gateway.
2. In another terminal, from the repository root:

   ```sh
   cd example/digital-human-vidu
   npm ci
   cp .env.example .env.local
   # Edit .env.local with your Vidu API key and ARTC AppID/AppKey.
   npm run desktop:vidu
   ```

3. A draggable, always-on-top Vidu window opens at the bottom-right of the screen. Click ⚙, provide a single-person character image URL or upload a PNG/JPEG/WebP file (up to 4 MB). Click **开始对话**, allow microphone access, then speak. For text chat, open the browser page at `http://127.0.0.1:5181`. Click **结束对话** before stopping the example with Ctrl-C.

## Choose a UI

From this directory, `npm run desktop:vidu` (or `npm run desktop`) starts the Vidu floating window; `npm run desktop:orb` starts the original Qwen Audio Agent orb unchanged. `npm run dev` starts the browser version at `http://127.0.0.1:5181`. The floating window's settings include **切换到悬浮球**: it ends the avatar conversation, closes its owned runtime, and opens the stock orb.

The two UIs share Gateway configuration, provider, backend/tools and persistent state; they have separate window preferences and conversation sessions. This is an alternative host, not an orb skin or a replacement for the stock desktop. Choose one active microphone UI at a time. End/quit the orb before starting an avatar conversation. The avatar does not copy the orb's wake-word or auto-hide behavior. Configure voice/tools through the stock orb's settings; restart the Vidu runtime to load changes. This PR does not add a selector inside the stock settings UI.

A running Gateway is borrowed and remains running when the Vidu host exits. If no matching desktop lease exists, the Vidu host starts a Gateway using the existing shared process manager and stops it on exit. If the browser example already owns the Vidu server, the floating window attaches and leaves that server running on quit.

`VIDU_GATEWAY_ORIGIN` optionally selects a specific local HTTP Gateway origin. This development example uses ports 5181/5182 and accepts browser requests from `http://127.0.0.1:5181`; use that exact URL. `VIDU_HOST` accepts `api.vidu.cn` or `api.vidu.com`. Secrets are read from the environment or `.env.local` only, never bundled in browser assets. Keep the ARTC application configured for token authentication.

Starting a conversation initializes a Vidu live and **can incur Vidu/ARTC charges**. It creates a fresh Gateway conversation ID and a new RTC channel each time. Gateway disconnect, initialization timeout, live hangup and Ctrl-C close the control link. Unconnected local session handles expire after one minute; active sessions close after two hours, before their RTC credentials expire. Token renewal and remote deployment are outside this example.

## Integration boundary

```text
Microphone / text → Gateway SDK → existing Gateway / provider / backend / tools
                                  ↓ assistant PCM / transcript / interruption
                          local Vidu WebSocket proxy
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
