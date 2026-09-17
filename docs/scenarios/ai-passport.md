# AI Passport Voice Client

Run Qwen Voice Bean on an AI Passport (ESP32-C3) card to use qwen-audio-agent over
the LAN. The card captures speech, plays replies, and displays character animation;
the Gateway on the computer handles realtime conversation, tools, and optional
backend Agent tasks.

## Demo

> Turn on sound. **Due to hardware limitations, the reference device currently
> supports half-duplex mode only.** Microphone upload pauses during reply
> playback; automatic voice interruption is not supported.

<video controls playsinline preload="metadata" style="width: 100%; max-width: 320px; border-radius: 12px;">
  <source src="https://github.com/user-attachments/assets/0af4ce90-ee59-4950-9d0b-cfc5a7d5c7d1" type="video/mp4">
</video>

## Core features

- Hardware microphone, speaker, buttons, and screen replace a desktop or browser UI.
- Gateway Client Protocol (GCP) messages travel over the LAN; the device relay splits audio into smaller chunks for the card.
- The normal Gateway retains its voice frontend, tools, and backend Agent configuration.

## Connection setup

The card does not connect directly to the Gateway. It connects to the device
relay over the LAN, which connects to the local Gateway on the same computer.

| Component | Responsibility |
|---|---|
| Qwen Voice Bean firmware | Wi-Fi setup, capture/playback, half-duplex control, buttons, and animation on the AI Passport card. |
| Device relay (`device-relay.mjs`) | Listen on the computer's LAN port `3101`, validate device tokens, split audio into small chunks, and forward GCP messages. |
| qwen-audio-agent Gateway | Listen on `127.0.0.1:18888` on the same computer; handle realtime conversation, tools, and optional backend tasks. |

The device relay and Gateway run as two separate processes on the same computer,
handling card transport and conversation/task execution respectively.

## Run the example

Configure the ordinary Gateway using the [quickstart](../getting-started/quickstart.md).
From a repository checkout, install dependencies and start it on a loopback port:

```bash
npm ci
node cli/bin/qwenaudio.mjs gateway run --url http://127.0.0.1:18888
```

In another terminal, copy and edit the relay configuration:

```bash
cp examples/ai-passport/.env.example examples/ai-passport/.env.local
```

Set `DEVICE_ACCESS_TOKEN` to a private token of at least 24 characters, set
`DEVICE_HOST=0.0.0.0` explicitly for trusted-LAN access, and leave
`GATEWAY_URL=http://127.0.0.1:18888` and `DEVICE_PORT=3101` for this setup.
The device token is not a model API key.

```bash
npm run example:ai-passport
```

Install the firmware from the [hardware community](https://ai-passport.folotoy.cn/plays/233/),
then configure the card with the computer's LAN IP and the matching device
token. The reference firmware uses `ws://COMPUTER_LAN_IP:3101/api/realtime`.
Disconnect other conversations for the same Gateway user before connecting it.

Keep the computer awake and allow port `3101` through its firewall. This example
uses plaintext WebSocket on a trusted LAN only. Keep token validation enabled
and do not expose the relay to the internet.

## Half-duplex use and limitations

Short-press confirm to enable the microphone, speak, and wait for the reply to
finish before speaking again. Press down for a manual interruption. Playback
pauses microphone upload; the current device has no AEC or automatic voice
interruption.

## Source and acknowledgements

- [Example and protocol checklist](https://github.com/QwenAudio/qwen-audio-agent/tree/main/examples/ai-passport): full setup instructions, audio transport, and tests.
- [External firmware](https://github.com/liutaocode/esp32demo/tree/main/examples/qwen-voice-bean): hardware drivers, interaction, and UI.
- [Tao Liu](https://github.com/liutaocode) implemented the firmware, hardware interaction, character UI, and device relay; [Li Xu](https://github.com/x-lixu) maintains the framework-side integration and documentation. The [FoloToy community](https://ai-passport.folotoy.cn/plays/233/) hosts firmware distribution.
