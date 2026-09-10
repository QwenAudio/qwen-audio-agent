# Embedded voice device ingress

[简体中文](README_ZH.md)

This example connects a memory-constrained native voice device to the public
Gateway WebSocket protocol. It splits large `audio.delta` messages and bounds
outbound buffering for slow devices. It does not replace the
Gateway, change its providers, or implement a hardware audio driver.

Hardware-specific firmware belongs in a separate project. This ingress was
extracted from a small ESP32-C3 voice companion, but repeated microphone
pause/resume and long-running network behavior still need hardware acceptance.
Automated tests are not a claim of production reliability. See the original
[Qwen Voice Bean firmware and hardware integration](https://ai-passport.folotoy.cn/plays/233/).

## Run

Install this repository's dependencies with `npm ci` and run a Gateway on the
same computer. Configure its voice provider and backend Agent as usual. Keep the
Gateway bound to loopback. The ingress is a trusted local client of that Gateway. Configure a separate
private `DEVICE_ACCESS_TOKEN` (at least 24 characters) for ingress access.
Never put a real token in source control or paste it into a terminal command.

```sh
# Populate DEVICE_ACCESS_TOKEN in your private environment first.
GATEWAY_URL=http://127.0.0.1:18888 \
  node examples/embedded-voice-device/gateway.mjs
```

The ingress defaults to `127.0.0.1:3101` and requires bearer authentication.
Explicitly set `DEVICE_HOST=0.0.0.0` for a device on your trusted LAN. Set
`DEVICE_PORT` to change the port. The device connects to
`ws://COMPUTER_IP:3101/api/realtime` with an `Authorization: Bearer …` header.
The upstream URL must be loopback. The ingress shares local Gateway authority;
it does not provide per-device pairing, identity isolation, or revocation. Use the
Gateway’s native paired access instead when you need those controls.

For devices without token entry, `DEVICE_ALLOW_TOKEN_FREE=1` explicitly disables
**device-side** authentication. The upstream connection remains loopback-only. Anyone who
can reach a token-free ingress can use your Gateway and incur provider costs;
use it only on an isolated trusted LAN. This example uses plaintext LAN WS and
must not be exposed directly to the internet. Browser Origin headers and all
HTTP routes except the minimal health endpoint are rejected.

## Device protocol checklist

Use the public `qwen-audio-agent/gateway-client-protocol` contract. Give every
physical device a stable, unique `client.instance_id`; duplicate identities can
replace an existing connection. Advertise `input.audio` and `playback.receipts`
in `session.hello`. Wait for `session.ready` and `voice.ready` before capture;
use the provider's announced input and output sample rates.

- Send mono PCM16LE, base64 encoded, in `input_audio_buffer.append`. Small chunks
  (for example 20 ms) avoid large allocations. Do not store recordings by default.
- Decode `audio.delta` incrementally. The ingress limits each base64 audio field
  to 4096 characters, preserves the response ID, and makes split event IDs unique.
- Send `playback.started`, `playback.ended`, and `playback.cancelled` when the
  **speaker** starts, drains, or cancels. Receiving the last network chunk does
  not mean playback has finished.
- For a half-duplex device, pause microphone upload during speaker playback and
  drain microphone buffers before resuming to avoid uploading speaker echo.
  This example supplies no AEC or automatic voice interruption.
- On microphone pause, cancel the response, send `input.mute`, discard queued
  capture/playback, and reject late audio. On resume, send `wake` then
  `input.unmute` before sending fresh capture. A local upload flag alone does not
  synchronize the Gateway's input or sleep state. Gate late replies by response
  ID or capture generation in the device implementation.
- On a transient provider outage, wait for `voice.ready` on the retained Gateway
  connection. Do not confuse provider recovery with Wi-Fi disconnection.

The relay keeps reading upstream during congestion so WebSocket Ping/Pong still
works. GCP `session.ping` bypasses the audio queue unchanged; a device advertising
`session.heartbeat` must send its own correlated `session.pong`. The relay does
not answer application heartbeats on the device's behalf. Other queued events
retain their order. Valid upstream close codes and reasons are preserved; clients
must not automatically retry `4001` (replaced), `4002` (occupied), or `4003` (revoked).

The application queue is bounded to 2 MiB and WebSocket messages to 1 MiB; excessive traffic closes the
connection rather than growing memory without a bound. These are example limits,
not a throughput or real-time guarantee. Status logs contain no audio or tokens.

## Test

```sh
npm run test:embedded-voice-device
```

Tests use a local fake upstream with no provider key or model calls. They cover
required/optional authentication, route and Origin rejection, ordered pause/resume
controls, exact PCM reconstruction after chunking, and a 600,000-byte burst to a
paused reader. Regression tests also cover heartbeats during simulated congestion,
queue overflow, close-code forwarding, and the public Gateway client's terminal
reconnect behavior. Real microphones, speaker echo, Wi-Fi loss, and firmware recovery
must be tested on the target hardware.
