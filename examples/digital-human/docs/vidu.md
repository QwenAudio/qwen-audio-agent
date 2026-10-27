# Vidu / ARTC native audiovisual preview

[中文](vidu.zh.md) · [Overview](../README.md)

The adapter forwards assistant PCM from Gateway to Vidu and plays returned ARTC audio and video together in one native media element. Vendor code stays inside the example. Gateway only adds a generic fallback for explicit capability negotiation without playback receipts; there is no new public protocol, vendor implementation or vendor SDK dependency in the framework.

**This commercial integration is experimental and disabled by default. This revision has not been accepted against the real Vidu service; do not use it for production workflows requiring automatic spoken-delivery confirmation.** Self-hosted DHAV remains the default with actual-playback receipts.

**Gateway revision requirement:** use a Gateway containing the generic receipt-less fallback. Until released, follow the [source-checkout instructions](../README.md#run) on this branch. Older published versions may wait indefinitely for receipts before displaying transcripts or advancing scheduling. Updating only the example or client SDK is insufficient.

## Playback boundary

Vidu does not negotiate `playback.receipts` and sends none of `playback.started/ended/cancelled`. DHAV's actual-playback receipts are unchanged. There is no muted source PCM player or original-audio comparison switch.

For a GCP client that explicitly negotiates capabilities without `playback.receipts`, Gateway displays generated transcripts, records ordinary dialogue and releases generation-side scheduling on generation completion. It does not claim audio was played. Automatic background-result notifications remain pending rather than being claimed for announcement. Framework task records, query and control APIs remain available; users can ask for task status by voice or text, but this minimal example has no full task-card or permission-management UI. Legacy clients retain their existing behavior.

Source `audio.done` only seals that reply's input; it does not prove that Vidu has finished producing media or that the browser has played it all. Silence gaps, input duration, waveform matching and estimated timers are not completion proofs. The adapter does not extract and reschedule the native audio/video tracks.

As checked on 2026-10-27, the [official component parameters](https://platform.vidu.com/vidu-stream/doc/s2-avatar/component/parameters) expose no output-end marker correlated to a client reply ID. The [official WebSocket reference](https://github.com/shengshu-ai/vidu-s-api/blob/main/skills/vidu-s-api/references/websocket-protocol.md) specifies a type 7 interrupt request but no matching acknowledgement proving that old media has drained. Initialization, RTC join and hangup are not per-reply completion signals. This describes the public interfaces, not the vendor's internal capabilities.

Disabling receipts prevents false claims; it does not solve delivery confirmation. Integration with the shared playback controller still needs supplier-backed reply boundaries and observable player drain. Heard-position feedback and model-history truncation are not implemented.

## Input readiness is not playback completion

After joining ARTC and configuring reception, the example-local `onInputReady` callback releases queued PCM without waiting for returned tracks. This avoids deadlock with a vendor that publishes media only after receiving the first audio packet. The separate `onReady` callback updates media presentation after native playback starts; it sends no Gateway receipt. A bounded timeout handles missing media after input has been sent.

## Interruption and isolation

On interruption, new text input or Gateway output clearing, the client immediately mutes, pauses and detaches old RTC media. It rejects old PCM and invalidates old callbacks and credentials.

The server makes a best-effort type 7 interrupt request, then hangs up the old live. The next valid reply creates a fresh epoch, live and RTC channel rather than unmuting the old stream. Local stopping does not wait for a remote acknowledgement.

Normal source completion does not hang up or estimate playback completion. Idle lives may incur charges. Recreating a connection after interruption increases startup latency and may increase session charges. End releases the current session.

Initialization, playback or connection failure reports an error and stops microphone capture until reconnection. No original audio is automatically replayed. Manually muting the microphone affects input only.

## Setup

Create a key with S2 Avatar component access at the [Vidu API platform](https://platform.vidu.cn/). Create an ARTC application using the [Alibaba Cloud Live guide](https://help.aliyun.com/zh/live/activate-application) and copy its AppID/AppKey, not an account AccessKey. Start the compatible Gateway revision described above, then configure this example's `.env.local`:

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

Use `api.vidu.com` for international keys. Enable `VIDU_EXPERIMENTAL` only after accepting the limitations and charges; its template default is 0. The key has no `Token` prefix. Environment variables override `.env.local`; restart after changes. Keep long-term credentials server-side; temporary RTC credentials are generated automatically.

```sh
npm ci
npm run build:client
npm start
```

Before connecting, choose the default image, an HTTPS URL or a PNG/JPEG/WebP upload up to 4 MB. The default preview is bundled locally. Vidu mode requests microphone access after connecting. The floating window shares the same page; the original orb remains a separate UI option. Use only one microphone client at a time.

## Resources and validation

ARTC Web SDK is pinned to 7.1.9. Source uploads are bounded to 4.8 MB per reply, pending input is bounded, and a live lasts at most 30 minutes. Failures and expiry release sessions and require reconnection. If creation times out before a live ID is received, check remote session state and billing.

See the [current validation record](presentation-validation.zh.md) and [deployment checklist](implementation-plan.zh.md). The [historical demo](../assets/digital_human_demo_vidu.mp4) and older alignment experiments do not establish acceptance of this revision.
