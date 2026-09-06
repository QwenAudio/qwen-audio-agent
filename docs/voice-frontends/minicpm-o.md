# Using the MiniCPM-o Realtime Frontend

qwen-audio-agent can connect to a user-managed
[MiniCPM-o 4.5 Realtime service](https://github.com/OpenBMB/MiniCPM-o-Demo) as a local voice
frontend. The Gateway does not install the model or manage the inference process.

The integration targets the official audio full-duplex WebSocket protocol:

```text
ws://127.0.0.1:8006/v1/realtime?mode=audio
```

Set the provider and endpoint after the service is ready:

```bash
QWEN_AUDIO_REALTIME_PROVIDER=minicpm-o
MINICPM_O_REALTIME_URL=ws://127.0.0.1:8006/v1/realtime?mode=audio
```

The adapter converts the clients' 16-bit PCM stream to the protocol's 16 kHz mono float32 input,
converts its 24 kHz mono float32 output back to 16-bit PCM, and maps MiniCPM-o session and response
events into the shared realtime runtime.

MiniCPM-o's public Realtime protocol does not currently define structured function-call events or
input transcription events. The first integration therefore focuses on local realtime voice
conversation; capabilities that require frontend tool calls remain unavailable for this provider.
