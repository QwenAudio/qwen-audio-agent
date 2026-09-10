# AI Passport Voice Client Example

English | [中文](README_ZH.md)

Run Qwen Voice Bean on an AI Passport (ESP32-C3) card to use qwen-audio-agent over
the LAN. The card captures speech, plays replies, and displays character animation;
the Gateway on the computer handles realtime conversation, tools, and optional
backend Agent tasks.

This directory contains the computer-side device relay. Card firmware is maintained
separately; see the [Qwen Voice Bean community guide](https://ai-passport.folotoy.cn/plays/233/)
and [firmware repository](https://github.com/liutaocode/esp32demo/tree/main/examples/qwen-voice-bean).

## Demo

A hardware demonstration of Qwen Voice Bean's voice interaction and character
animation. Turn on sound for the full experience.

> **Due to hardware limitations, only half-duplex mode is currently available.**
> Microphone upload pauses during replies; wait for playback to finish before speaking.
> Automatic voice interruption is not supported; use the button to interrupt manually.

https://github.com/user-attachments/assets/0af4ce90-ee59-4950-9d0b-cfc5a7d5c7d1

## Core features

- **Card interaction:** use the onboard microphone, speaker, buttons, and screen
  for voice conversations and character state feedback.
- **Tools and tasks:** reuse the Gateway's configured voice frontend and tools;
  delegate tasks to a backend Agent when enabled.
- **LAN transport:** carry Gateway Client Protocol (GCP) messages through a device
  relay that splits audio into small chunks and bounds buffering.

## Connection setup

In this example, the card does not connect directly to the Gateway. It connects
to the device relay on the computer, which connects to the local Gateway.

| Component | Deployment in this example | Responsibility |
|---|---|---|
| Qwen Voice Bean firmware | AI Passport card | Capture/playback, half-duplex control, Wi-Fi setup, buttons, and character animation. |
| [Device relay (device-relay.mjs)](device-relay.mjs) | Computer, `LAN_IP:3101` | Validate the device token, split reply audio into small chunks, buffer and forward GCP messages. |
| qwen-audio-agent Gateway | Same computer, `127.0.0.1:18888` | Realtime conversation, tools, and optional backend tasks. |

The computer runs **two separate processes**. Port `3101` belongs to the LAN
relay; port `18888` belongs to the loopback-only Gateway.

## Quick start

You need an AI Passport card and a computer on the same reachable, trusted LAN.
Run all commands below from the repository root with a supported Node.js version.

### 1. Configure and start the Gateway

Install dependencies and configure the voice frontend:

```bash
npm ci
node cli/bin/qwenaudio.mjs config
```

Configure a working voice frontend using the
[Gateway quickstart](../../docs/getting-started/quickstart.md). A backend Agent
is optional; install and authorize it separately if you need task execution.

Start the Gateway in the first terminal and leave it running:

```bash
node cli/bin/qwenaudio.mjs gateway run --url http://127.0.0.1:18888
```

You can verify speech in the WebUI at `http://127.0.0.1:18888` first. Disconnect
that conversation before connecting the card to avoid an active-client conflict
for the same user.

### 2. Configure and start the device relay

```bash
cp examples/ai-passport/.env.example examples/ai-passport/.env.local
```

Edit `.env.local`: set a private `DEVICE_ACCESS_TOKEN` of at least 24 characters
and configure:

```dotenv
GATEWAY_URL=http://127.0.0.1:18888
DEVICE_HOST=0.0.0.0
DEVICE_PORT=3101
DEVICE_ALLOW_TOKEN_FREE=0
```

`DEVICE_HOST=0.0.0.0` lets the card reach the relay over the LAN. The device token
is not a model API key: use the same token on the card and relay, and keep model
credentials in the Gateway configuration. Do not commit `.env.local` with real tokens.

Start the relay in the second terminal and leave it running:

```bash
npm run example:ai-passport
```

This command only loads `.env.local` and starts `device-relay.mjs`; it does not
start another Gateway.

### 3. Connect the card

Install Qwen Voice Bean using the [community guide](https://ai-passport.folotoy.cn/plays/233/).
In the card's setup page, enter the computer's LAN IP and the matching device
token. The firmware fills in port `3101` and `/api/realtime`:

```text
ws://COMPUTER_LAN_IP:3101/api/realtime
```

Do not enter `127.0.0.1` or `0.0.0.0` on the card. Keep the computer awake and allow
port `3101` through its firewall. This example uses plaintext WebSocket on a
trusted LAN only; keep token validation enabled and do not expose the relay to the internet.

## Usage

1. Short-press confirm to enable the microphone; it starts disabled at boot.
2. Say a request, then pause and wait for the spoken reply.
3. During playback, the device pauses microphone upload. Wait until playback
   finishes before speaking again, or press down to interrupt manually.

Press up to change volume and long-press confirm to open settings. See the
community guide for current controls.

When finished, disable the card's microphone or disconnect it, then press `Ctrl+C`
in each terminal to stop the relay and Gateway.

## Protocol and tests

The [device protocol checklist](docs/device-protocol.md) describes PCM formats,
playback receipts, pause/resume, heartbeats, and connection recovery.

```bash
npm run test:ai-passport
```

Tests cover device authentication, message forwarding, audio chunking, buffering,
and connection recovery without model keys. Real audio and Wi-Fi stability still
need validation on the card.

## Authors and acknowledgements

- [Tao Liu](https://github.com/liutaocode): implemented the Qwen Voice Bean firmware,
  hardware interaction, character UI, and device relay.
- [Li Xu](https://github.com/x-lixu): maintains the framework-side integration,
  protocol lifecycle fixes, regression coverage, and example documentation.
- [FoloToy AI Passport community](https://ai-passport.folotoy.cn/plays/233/):
  hardware platform and firmware distribution.
