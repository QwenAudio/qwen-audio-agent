# WebRTC client access preview

Status: experimental 0.1. This adds a client-to-Gateway transport, not an avatar implementation.

```text
Client -- WebRTC Track / DataChannel -- Node media worker -- IPC -- Session runtime -- WSS -- Bailian
Client ---------------- Original WSS --------------------------- Session runtime -- WSS -- Bailian
```

The Gateway continues to own authentication, session history, tools, background
tasks, content-safety recovery, and client ownership. It does not merely relay
SDP for a direct client-to-provider connection. Provider credentials remain on
the server. The existing `/api/realtime` WebSocket API and default dependencies
are unchanged.

## Start

See the [browser example](https://github.com/QwenAudio/qwen-audio-agent/tree/main/examples/webrtc) for release and source workflows.
The release workflow uses a separate extension, which is not yet published:

```sh
npm install -g qwen-audio-agent qwen-audio-agent-webrtc
qwenaudio gateway --webrtc
```

Install both packages with the same npm prefix. Installing the extension does
not enable WebRTC. WSS-only users do not need the extension.

For source development, run from the repository root after installing the project:

```sh
npm run example:webrtc:install
npm run example:webrtc
# For camera input, stop Audio and run npm run example:webrtc:omni
```

The demo enables WebRTC and selects the model for this process only. It does not
modify saved settings. A normal Gateway can use `qwenaudio gateway --webrtc`
after configuring a supported DashScope Audio/Omni model and installing the
extension. Persistent services use `qwenaudio gateway install --webrtc`, followed
by the normal start/restart commands.

An alternative source launch is:

```sh
QWAUDIO_WEBRTC_ENABLED=1 \
QWEN_AUDIO_REALTIME_PROVIDER=dashscope \
QWEN_AUDIO_REALTIME_MODEL=qwen-audio-3.0-realtime-plus \
npm run start --workspace server
```

For Omni, change the model to `qwen3.5-omni-plus-realtime` and restart. Reuse the
server's existing `DASHSCOPE_API_KEY` and regional/workspace configuration. Never
enter a provider key in the browser. Requests cannot override the Gateway's
configured model or upstream URL.

Open the example at the default port:

```text
http://127.0.0.1:3101/api/realtime/webrtc/example
```

The UI provides microphone/camera input, text, interruption, session IDs,
explicit takeover, and diagnostics. Remote access uses existing Gateway
pairing/authentication. Browser credentials are Gateway credentials, not Bailian
keys; the page and its assets are also protected by Gateway authentication.

When disabled, no WebRTC routes, native addons, or media timers are activated.
Native dependencies belong to `qwen-audio-agent-webrtc`; source development
installs them under `packages/webrtc`. The main npm package contains neither
the extension implementation nor its native dependencies or private `.env` files.
When enabled, WSS and WebRTC coexist; the upstream model connection remains WSS.

## API

All endpoints use existing HTTP authentication and Origin checks. `ownerId`
comes from the authenticated identity, not client-provided identity fields.
History remains isolated by authenticated owner and `sessionId`.

### Media configuration

`GET /api/v1/webrtc/config`

Returns the current `model`, `video_input`, `iceServers`, and
`iceTransportPolicy`. ICE configuration is available only to authenticated
clients, and the response is not cacheable.

### SDP negotiation

```http
POST /api/v1/webrtc/realtime?model=qwen-audio-3.0-realtime-plus&sessionId=my-session
Authorization: Bearer <Gateway access credential>
Content-Type: application/sdp

v=0
...
```

Local or paired browsers can use existing authentication without an explicit Bearer header.

- Success: `200 application/sdp`, with the Answer SDP as the body.
- `Location` identifies the connection's deletion endpoint, not its history session.
- Errors: JSON `{"error":{"code":"...","message":"..."}}`.
- Offers must contain one audio media section and one DataChannel section; Omni may add one video section.
- `model` is optional but must match the configured model when provided.
- `sessionId` defaults to `main` and accepts 1-128 letters, digits, or `_ . : -`.
- `takeover=true` explicitly takes over the current owner's voice connection; takeover is not automatic.
- Optional `client_actions` is a JSON array (for example `["xomni.visual.capture"]`) declaring implemented client actions.
  Up to 16 distinct names are allowed. Runtime negotiation intersects them with host-registered capabilities; clients cannot inject tools or prompts.
- Send `pc.localDescription.sdp` after gathering ICE candidates. Trickle ICE, renegotiation, and ICE restart are not supported in this preview.

### Close a connection

Send `DELETE` to `Location`. Success returns `204`; another owner's connection
returns `404`. Closing the PeerConnection also triggers cleanup. Credential
revocation applies to connections still negotiating.

Closing a connection does not delete history. Reconnect with the same owner
and `sessionId` to reuse the existing restoration flow.

## Minimal browser connection

```js
const config = await fetch('/api/v1/webrtc/config').then(r => r.json())
const pc = new RTCPeerConnection({ iceServers: config.iceServers })
const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
for (const track of stream.getTracks()) {
  track.enabled = false
  pc.addTrack(track, stream)
}
pc.createDataChannel('oai-events', { ordered: true })
pc.ondatachannel = ({ channel }) => {
  if (channel.label !== 'txt') return
  channel.onmessage = ({ data }) => {
    const event = JSON.parse(data)
    if (event.type === 'session.updated') {
      for (const track of stream.getTracks()) track.enabled = true
    }
    // Handle errors, transcripts, Gateway events, and playback receipts.
  }
  // The server-created txt channel is bidirectional; send controls here.
}
pc.ontrack = ({ track }) => {
  audioElement.srcObject = new MediaStream([track])
  audioElement.play().catch(showPlaybackButton)
}
await pc.setLocalDescription(await pc.createOffer())
// Wait for pc.iceGatheringState === 'complete'; see the full example.
const response = await fetch('/api/v1/webrtc/realtime?sessionId=my-session', {
  method: 'POST', headers: { 'Content-Type': 'application/sdp' },
  body: pc.localDescription.sdp,
})
if (!response.ok) throw await response.json()
await pc.setRemoteDescription({ type: 'answer', sdp: await response.text() })
```

The full client in `examples/webrtc/client.mjs` includes ICE timeouts,
authentication, cleanup, and playback handling.

## Relationship to Bailian Realtime

Negotiation follows the style of the
[Bailian Realtime connection API](https://help.aliyun.com/zh/model-studio/realtime-connect-model):
raw SDP, audio/video Tracks, a reliable ordered DataChannel, and the server's
`txt` channel. These are familiar semantics, **not full API passthrough**.

| Client input | Preview behavior |
| --- | --- |
| `session.update` | Supports output `voice`; `modalities` must be `["text","audio"]`; VAD values must match Gateway configuration |
| `conversation.item.create` | Stages one user `input_text` message and returns `conversation.item.created` |
| `response.create` | Submits the staged text through the Gateway input flow; per-response overrides are rejected |
| `response.cancel` | Cancels generation and clears queued audio; targeting a specific response ID is unsupported |
| Audio Track | Converts audio to the Provider's PCM format; clients do not send Base64 audio events |
| Video Track | Samples up to one JPEG per second, maximum dimension 640 pixels and Base64 size 256 KiB, using the existing vision input flow |
| Manual audio commit, client tools/instructions, arbitrary history injection | Unsupported; return structured errors rather than bypassing Gateway policy |

Server events include `session.created`, `session.updated`, `response.created`,
`response.audio.done`, `response.done`, transcript delta/completion events,
`output_audio_buffer.cleared`, and `error`. `response.done` includes the response
ID and provider completion status, not Bailian's full output/usage structure.

Client item IDs are not guaranteed to match upstream IDs. Staged text is
submitted to history only on `response.create`. User transcript events use
familiar names without promising upstream item IDs. `response.audio_transcript.*`
represents text presented by the Gateway, not necessarily an original TTS transcript.

Other Gateway events are wrapped as `{"type":"qwaudio.event","event":{...}}`.
Use the `event` field of `qwaudio.command` for supported GCP task, permission,
and history commands. Existing capability, permission, and owner checks still
apply; commands are not forwarded directly to the provider.

Client actions retain GCP semantics: `client.action.request` arrives inside
`qwaudio.event`; return `client.action.result` through `qwaudio.command`, keeping
`request_event_id`. Send `client.event.publish` through the same command channel,
without opening a second WebSocket session.

Large inbound JSON, such as capture results, can use `qwaudio.transport.chunk`:
`{type, id, index, total, data}`. Indices are consecutive from zero; `data` is a
JSON text fragment. Each fragment holds at most 8,192 UTF-16 code units, each
wire frame at most 64 KiB, and each reassembled message at most 512 KiB. Only one
partial message per connection is allowed; it expires after five seconds.
Nested chunks are rejected. Reassembled events undergo the same validation
and authorization as ordinary messages. Small events need no fragmentation.
Reuse `shared/gateway/webrtc-browser.mjs` and `webrtc-message.mjs` instead of
sending images larger than the SCTP single-message limit.

### Playback receipts and interruption

Generation completion, server RTP drain, and client playback completion are distinct:

- `qwaudio.output.started`: the server started sending a response, not proof it was heard.
- `qwaudio.output.drained`: the server queue is empty; browser buffering may remain.
- Send `qwaudio.playback.started` with `response_id` when client playback begins.
- Send `qwaudio.playback.ended` or `qwaudio.playback.cancelled` after playback or cancellation.
- Receipts drive existing transcript, history, and notification handling; the server does not fabricate them.

The example estimates playback using the audio element and received audio level,
and provides a manual acknowledgement button. This is not exact billing or
proof of delivery. Browser APIs cannot directly clear the remote RTP jitter
buffer. Interruption clears server queues and rejects subsequent old-response
audio, but a short buffered tail may remain. The example briefly mutes after
clearing; stricter guarantees require further validation.

## Deployment boundaries

- CPU media bridging only; no GPU, Python, room service, or SFU platform.
- `@roamhq/wrtc` and `sharp` load only in on-demand Node media workers, one per connection. Provider keys and history are not sent to workers. Binary/platform support needs platform-specific validation.
- The native library can crash during natural teardown on macOS ARM64. Workers close media resources, acknowledge cleanup, then exit explicitly. The Gateway waits for actual process exit; crashes or forced kills are not reported as graceful shutdowns.
- Retiring workers still consume connection quota. Gateway shutdown waits for workers; loss of parent IPC ends the child.
- Defaults: four connections, a 20-second connection deadline, a 30-minute connection lifetime, and a 10-second disconnection grace period.
- Output queues are bounded to 60 seconds. Slow consumers, invalid media sequences, or congested DataChannels close the affected connection.
- Input video frames exceeding 1080p are dropped; clients should request 640x480. Encoding limits do not replace public-service quotas.
- Failure does not silently switch to WSS; clients explicitly retry or choose WSS.
- Remote access requires HTTPS, reachable media ports, and STUN/TURN as needed. An HTTP proxy or tunnel does not relay WebRTC media.

Optional environment variables:

```sh
QWAUDIO_WEBRTC_ENABLED=1
QWAUDIO_WEBRTC_ICE_SERVERS='[{"urls":"turn:turn.example.com:3478","username":"short-lived-user","credential":"short-lived-credential"}]'
QWAUDIO_WEBRTC_ICE_TRANSPORT_POLICY=all
```

Authenticated clients receive the configured ICE settings. Do not embed
long-lived, privileged TURN credentials. Multi-instance routing, dynamic TURN
credentials, quotas, and public-network endurance remain deployment work;
this preview does not claim production certification.

## Tests

```sh
node --test server/test/webrtc.test.mjs server/test/webrtc-transport-regressions.test.mjs server/test/webrtc-media-process.test.mjs server/test/gateway-client-handshake.test.mjs server/test/gateway-application.test.mjs
npx playwright install chromium
QWAUDIO_TEST_WEBRTC_NATIVE=1 node --test server/test/webrtc-native.test.mjs
```

Default tests do not require native addons. Native tests open the actual UI in
Chromium with synthetic microphones/cameras, repeat connections, and check
transcripts, restored history, cleanup, and crash isolation from WSS. A mocked
upstream Provider avoids real model calls or uploads of personal history.
These tests do not establish model quality, broad browser compatibility, or
public-network stability.

Manual acceptance should cover Audio and Omni conversations, text, interruption,
reconnection, history/session isolation, explicit takeover, and Omni camera
questions. Disable WebRTC afterwards and repeat the original WSS flow.

## Code organization

- `routes.mjs`: SDP HTTP endpoints, quotas, authentication scope, and lifecycle.
- `protocol.mjs`: Bailian-style event mapping to the existing Gateway connection.
- `media.mjs`: PeerConnection, PCM pacing, JPEG sampling, and backpressure.
- `media-process.mjs` / `media-worker.mjs`: controlled processes, bounded IPC, cleanup acknowledgement, and crash isolation.
- `pcm.mjs`: PCM encoding, streaming resampling, and channel conversion.
- `transport/gateway-client-transport.mjs`: shared authenticated connection attachment for WSS and RTC.
- `shared/gateway/webrtc.mjs`: extension discovery and API/dependency checks without loading native addons.
- `shared/gateway/webrtc-browser.mjs`: shared browser connection, track lifecycle and playback receipts for both examples; no scenario tools.
- `shared/gateway/webrtc-message.mjs`: size/time-bounded inbound fragmentation without changing GCP semantics.
- `packages/webrtc/`: independently published extension with a lazy native factory, excluded from default workspace installs and the main package.
- `examples/webrtc/`: installation instructions, launch scripts, and plain browser UI.
