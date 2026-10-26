# Vidu / ARTC delayed presentation preview

[中文](vidu.zh.md) · [Overview](../README.md)

Vidu is a presentation side branch. Original model PCM is scheduled locally through a zero-gain
output; that source timeline alone owns Gateway `playback.started`, `playback.ended`, and
`playback.cancelled`. These are explicitly source-timeline receipts, not acknowledgements that
Vidu output has reached the listener. Vidu returns original RTC audio/video to one native media
element, preserving its native synchronization.

Gateway connects independently of Vidu initialization and RTC join. Vendor failures, unrelated
or delayed media, missing end markers and autoplay failure cannot cancel source playback, alter
its receipts, or cancel a model response. No waveform matching, estimated completion, extra
startup reserve, frame cache or quiet gate remains. Source PCM is forwarded unchanged; no PCM
chunk means no upload, with no inserted silence.

Interruption follows the original Realtime/Gateway input handling and stops original PCM.
Subsequent cancelled source chunks are fenced, but already uploaded media may continue.
There is no Vidu interrupt on response completion, user interruption, or the next response.
Only ending the session hangs up the live. This deliberately favors continuous delayed
presentation over immediate media cancellation.

The original-audio comparison checkbox mutes/hides the avatar and unmutes the same source
player. Switching does not recreate sources, reschedule PCM or change receipts. Both modes
share the ordinary local Web client's 20 ms scheduling lead. This verifies these two example
modes; it does not prove equivalence to every WebUI feature or remote playback transport.

## Tradeoff and review status

A three-second avatar delay means that at local second eight, the user hears approximately
source second five. The model may already have generated through second eight or beyond.
Keeping source-timeline control prevents display delay from changing Agent scheduling, but
does not resolve the listener/model context mismatch or provide heard-position truncation.

This design explicitly differs from the earlier review's requirement for actual ARTC playback
receipts and immediate cancellation/stale-media isolation. Maintainer agreement is still needed;
the adapter stays experimental and disabled by default. Historical alignment/live recordings
are not acceptance evidence for this design.

## Setup

Create a key at the [Vidu API platform](https://platform.vidu.cn/) using the
[quick start](https://platform.vidu.cn/vidu-stream/doc/s2-avatar/realtime/quick-start).
Use credentials with S2 Avatar component access. Create an ARTC application in the
[Alibaba Cloud Live console](https://help.aliyun.com/zh/live/activate-application) and copy
its AppID/AppKey (not your account AccessKey). Start your ordinary Gateway, then configure
`examples/digital-human/.env.local`:

```dotenv
DH_GATEWAY_URL=ws://127.0.0.1:18888/api/realtime
DH_CLIENT_PORT=5273
DH_RENDERER_ADAPTER=vidu
VIDU_EXPERIMENTAL=1
VIDU_API_KEY=vda_your_key
ARTC_APP_ID=your_app_id
ARTC_APP_KEY=your_app_key
VIDU_HOST=api.vidu.cn
```

Use `api.vidu.com` for international platform keys. The key has no `Token` prefix.
Environment variables override `.env.local`; restart after changes. Keep long-term credentials
server-side; temporary RTC credentials are generated automatically.

```sh
npm ci
npm run build:client
npm start
```

Choose the default image, an HTTPS URL, or a PNG/JPEG/WebP upload up to 4 MB before connecting.
The bundled preview works independently of access to the remote reference URL. Connecting
starts continuous microphone capture and a persistent live; idle time may incur charges.
Mic mute affects input only. Interrupt affects the original conversation; End closes both paths.
The desktop floating window and optional original orb remain available.

The SDK is pinned to ARTC Web SDK 7.1.9. Source uploads are bounded to 4.8 MB per response;
queued mirror input is bounded, and live duration is capped at 30 minutes. Presentation errors
release presentation resources only. If creation times out without a live ID, check remote billing
and session status. Prompt, search and other tools remain configured in your normal Gateway.

[Historical demo](../assets/digital_human_demo_vidu.mp4) ·
[Audio flow diagrams (Chinese)](audio-processing-flow.zh.md) ·
[Proposed PR description (Chinese)](pr-description.zh.md)
