# WebRTC client example

[中文](README_ZH.md)

Voice and text conversations through the Gateway's WebRTC interface, with camera
input for Omni. Existing WSS access is unchanged.

WebRTC is not yet published to npm. Use the source workflow for now.

## Release (npm)

Install the framework and optional WebRTC extension without cloning the repository:

```sh
npm install -g qwen-audio-agent
npm install -g qwen-audio-agent-webrtc
qwenaudio config
qwenaudio gateway --webrtc
```

In `qwenaudio config`, set `DASHSCOPE_API_KEY` and
`QWEN_AUDIO_REALTIME_PROVIDER=dashscope`. Audio uses the default model. For Omni,
set `QWEN_AUDIO_REALTIME_MODEL=qwen3.5-omni-plus-realtime` and restart the Gateway.

## Source development

After installing the project, run from its root:

```sh
npm run example:webrtc:install
export DASHSCOPE_API_KEY='your-key'  # Skip if already configured
npm run example:webrtc
```

For Omni, stop the current Gateway, then run:

```sh
npm run example:webrtc:omni
```

## Open the demo

With either workflow, open the [Web UI](http://127.0.0.1:3101/api/realtime/webrtc/example),
connect, and allow microphone access. Replace `3101` if needed. Omni supports camera
input. The model is selected at startup, not in the UI.

- Mute, interrupt, create sessions, and restore history with the same identity and session ID.
- The browser credential field takes a Gateway token, not a provider API key. Model calls incur API usage.
- Install the extension with the same npm prefix as the Gateway. Browsers and WSS-only users do not need it.
- Remote access requires HTTPS and reachable media ports, with STUN/TURN if needed.

[Protocol and deployment](../../docs/gateway-webrtc-client.md)

For screen/image input, on-demand inspection and observation reminders, try
the [X-Omni example](https://github.com/QwenAudio/qwen-audio-agent/tree/main/examples/x-omni/README.md) with its optional WebRTC transport.
Both examples share the browser connection and Gateway media implementation.
