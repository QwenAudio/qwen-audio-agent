# Using the MiniCPM-o Realtime Frontend

qwen-audio-agent connects to
[MiniCPM-o 4.5](https://github.com/OpenBMB/MiniCPM-o-Demo) through ModelBest's public Realtime
protocol. The endpoint may be a user-managed local deployment or a compatible hosted service;
the Gateway does not install the model or manage the inference process.

The integration targets the official audio full-duplex WebSocket protocol:

```text
ws://127.0.0.1:8006/v1/realtime?mode=audio
```

Set the provider and endpoint after the service is ready:

```bash
QWEN_AUDIO_REALTIME_PROVIDER=minicpm-o
MINICPM_O_REALTIME_URL=ws://127.0.0.1:8006/v1/realtime?mode=audio
```

The default assumes the upstream Gateway was started with `--http` on the loopback interface.
For ModelBest cloud or another TLS deployment, set its corresponding `wss://` endpoint instead.
`MINICPM_O_AUTH_TOKEN` is sent as a Bearer token when the endpoint requires one. The same fields
are available in Desktop Settings under **Voice frontend → ModelBest**, where the model is shown
as the fixed `MiniCPM-o 4.5`.

The adapter converts the clients' 16-bit PCM stream to the protocol's 16 kHz mono float32 input,
converts its 24 kHz mono float32 output back to 16-bit PCM, and maps MiniCPM-o session and response
events into the shared realtime runtime.

MiniCPM-o's public Realtime protocol does not currently define conversation items, structured
function-call events, client-triggered responses, or input transcription events. This integration
therefore focuses on realtime voice conversation. Typed input, restored transcript history,
proactive announcements, memory writes, and backend-Agent tools remain unavailable with this
provider. UI chat history is still retained locally where the client has content to display.
