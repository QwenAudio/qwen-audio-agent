# Vidu / ARTC experimental preview

[中文](vidu.zh.md) · [Overview](../README.md)

This adapter uses #573's ordinary Gateway, shared `useDualConnection` and
`AvatarPlaybackController`. Vendor control/credentials live in
`server/renderers/vidu.mjs`; `client/renderers/vidu.mjs` and `artc-player.mjs` own
native ARTC playback. There is no separate Vidu GCP client or silent reply clock.

## Merge blocker: response completion

The [public Vidu component protocol](https://platform.vidu.com/vidu-stream/doc/s2-avatar/component/parameters)
does not document a per-response last-media/drain marker. Gateway `audio.done`
only seals input. Subscription, video playback, RTC stats, silence, disconnect and
token expiry do not prove that no further reply media can arrive. The adapter
is disabled by default. Opt-in preview **never sends `playback.ended`** and is
unsuitable for tasks requiring accurate completion receipts; this is not a
merge-ready commercial integration.

Start is observed on the audible WebAudio graph using the SDK's remote audio
track; SDK automatic audio is muted to avoid double playback. This still needs
real ARTC validation and cannot confirm physical speaker output. Silent output
may not generate a started receipt.

Responses remain incomplete until explicit interruption/new input, error,
disconnect or a resource cap cancels them. New input is not natural completion.
Queued automatic replies cannot naturally advance while the boundary is missing;
tool announcements can remain pending. Each preview live is capped at 120 seconds;
expiry cancels rather than completes playback. Source PCM is limited to 4.8 MB
(100 seconds) per reply, with bounded pending input.

## API access and setup

1. Create a `vda_...` key in [Vidu China](https://platform.vidu.cn/), under API Key
   management; see the [account/credits guide](https://platform.vidu.cn/docs/quick-start).
   Confirm Component Edition access/credits. China keys use `api.vidu.cn`;
   [international platform](https://platform.vidu.com/) keys use `api.vidu.com`.
2. Create an Alibaba Cloud real-time audio/video application using the
   [official guide](https://help.aliyun.com/zh/live/activate-application), then copy
   AppID/AppKey from the same application's basic information. These are not
   account AccessKey credentials. The local server signs short-lived tokens with
   [ARTC token authentication](https://help.aliyun.com/en/ims/developer-reference/token-based-authentication).
3. Start an ordinary Gateway first, then edit `examples/digital-human/.env.local`:

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

Enable `VIDU_EXPERIMENTAL=1` only after accepting the above limits (template: 0).
Use the plain key without a `Token` prefix. Shell variables override the local
file; restart `npm start` after changes. Keep keys out of frontend/Vite variables.
You do not need to configure a manual RTC token.

```sh
npm ci
npm run build:client
npm start
```

Open the printed URL and read the experimental notice. Connect, choose the
default character, an HTTPS image or a PNG/JPEG/WebP upload up to 4 MB, then enable
the microphone or send text. First assistant audio creates a paid live. Vidu/ARTC
charges may apply even if playback fails. Use Interrupt/End to stop local media
and hang up; microphone mute alone does not end output or a paid session.

If creation times out before a live ID is obtained, remote creation cannot be
ruled out; check the platform's live state.

The browser loads official ARTC Web SDK 7.1.9 from its CDN. Only scoped RTC
credentials reach the browser; Vidu control secrets and long-lived keys stay in
the server. Separate live/channel state per response/generation isolates late
callbacks. Cancellation gates local audio/video before best-effort remote
interrupt/hangup, including late session-creation results. No original-PCM replay
is allowed after renderer failures.

## Remaining work and troubleshooting

Completion needs a verifiable vendor last-media marker correlated to the live,
response and generation, plus local queue-drain observation; alternatively an
explicitly agreed degraded receipt capability contract. Do not add model-terminal
or targeted-clear GCP messages or substitute fixed delays. Real paid multi-turn,
long-sentence, synchronization and post-cancel isolation acceptance is pending.

- Disabled connection: inspect `/api/config` renderer `enabled/reason`, preview flag and credentials.
- 401/403: check key environment, entitlement and credits.
- RTC authentication: verify matching AppID/AppKey, clock, network and SDK CDN.
- Autoplay blocked/suspended context: the reply is cancelled, never completed; reconnect through a user gesture.
- `session_expired`: preview resource cap, not successful completion; new input creates a fresh live.

Environment and overlay `.desktop/` state are ignored. Local deletion does not
delete remote data, whose retention follows service policies. The
[historical Vidu footage](../assets/digital_human_demo_vidu.mp4) illustrates the old
UI, not acceptance of this integration's playback lifecycle.
