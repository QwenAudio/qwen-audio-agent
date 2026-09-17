# AI Passport device protocol checklist

[中文](device-protocol.zh.md) · [Back to the example](../README.md)

Qwen Voice Bean sends [Gateway Client Protocol](../../../docs/gateway-protocol.md)
messages over the LAN. The device relay forwards them to the Gateway on the same computer.

## Session and audio

- Give every physical device a stable, unique `client.instance_id`. Duplicate
  identities can replace an existing connection.
- Advertise `input.audio` and `playback.receipts` in `session.hello`. Wait for
  `session.ready` and `voice.ready` before capture, and use the announced sample rates.
- Send mono PCM16LE, base64 encoded, in `input_audio_buffer.append`. Small
  capture chunks (for example 20 ms) avoid large allocations.
- Decode `audio.delta` incrementally. The relay limits each base64 audio
  field to 4096 characters, preserves response IDs, and makes split event IDs unique.
- Send `playback.started`, `playback.ended`, and `playback.cancelled` when the
  speaker actually starts, drains, or cancels. Receiving `audio.done` does not
  mean the speaker has finished.

## Half-duplex and interruption

The reference hardware currently exposes half-duplex mode only. It pauses
microphone upload during speaker playback and drains capture buffers before
resuming, so speaker echo is not submitted as a new user turn. It provides no
AEC or automatic voice interruption; a device button can interrupt manually.

On an explicit user pause that also stops the reply, send `response.cancel` and
`input.mute`, discard local capture/playback queues, and reject late audio by
response ID or capture generation. `input.mute` alone controls microphone input;
it is not an output cancellation command. On resume, send `wake` then
`input.unmute` before fresh microphone data. A local upload flag alone does not
synchronize Gateway input or sleep state.

The card's firmware controls half-duplex capture and playback.

## Heartbeats and recovery

- On a transient voice-provider outage, keep the Gateway connection and wait
  for `voice.ready`. Provider recovery is distinct from Wi-Fi disconnection.
- The relay keeps upstream reads active during congestion so WebSocket
  Ping/Pong still works.
- If the device negotiates `session.heartbeat`, answer `session.ping` with a
  `session.pong` whose `request_event_id` matches the ping's `event_id`.
  The relay forwards the ping ahead of queued audio, but never answers for
  the device. Other queued events retain their order.
- Valid upstream close codes and reasons are preserved. Do not automatically
  retry `4001` (replaced), `4002` (occupied), or `4003` (revoked); show the state
  and require an appropriate user action. Transient transport failures may use
  bounded reconnect backoff.

## Limits and acceptance

The application send queue is bounded to 2 MiB; upstream WebSocket messages to
1 MiB and device messages to 64 KiB. Excessive traffic terminates the connection
instead of growing memory without a bound. These are example limits, not a
throughput or realtime guarantee. The queue does not measure physical speaker
drain; firmware still owns playback buffering and receipts.

Use the [automated tests](../README.md#protocol-and-tests) for protocol regression.
On the device, also verify repeated microphone pause/resume, long replies,
manual interruption with late audio, Wi-Fi recovery, and contention with another
client. Do not infer hardware readiness from a successful health response alone.
