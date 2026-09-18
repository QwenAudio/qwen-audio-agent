# Qwen Audio Agent X-Omni Example

English | [中文](README_ZH.md)

A standalone reference implementation for realtime multimodal interaction with
qwen-audio-agent. It combines visual conversation, on-demand image inspection,
and user-requested visual observation through the framework's Gateway and
Realtime Provider interfaces.

Qwen3.5 Omni is the default configuration, not a requirement of the client
architecture. ModelBest MiniCPM-o supports continuous audiovisual conversation
through its existing adapter. Additional Omni services can be integrated
according to their transport and tool capabilities. Scenario tools, capture
policy, and observation scheduling remain inside this example.

## Core features

- **Visual conversation:** camera/screen selection, image loading,
  continuous frames, and on-demand inspection.
- **Optional observation:** bounded condition reminders and change
  narration, with cancellation, deduplication, deadlines, and concurrency limits.
- **Existing conversation runtime:** reuses the WebUI voice hook and Gateway
  Client Protocol for audio, interruption, playback receipts, and client actions.
- **Optional backend:** captured images have ordinary `input_N` references that
  `spawn_thinking` can pass to an installed backend; observation itself needs no backend.

## Model compatibility

| Frontend | Continuous audiovisual conversation | On-demand inspection / observation | Validation |
| --- | --- | --- | --- |
| Qwen3.5 Omni Realtime | Supported | Supported through the bundled DashScope visual reader | Plus verified against the live service; automated protocol and browser tests |
| ModelBest MiniCPM-o 4.5 | Supported with `mode=video` | Unavailable through the current public Realtime interface | Automated protocol and browser tests; deployment-specific inference requires verification |
| Other Omni services | Requires a Gateway adapter with image-buffer input | Requires structured tool calling, client-triggered replies, and a compatible visual reader | Not claimed as verified |

The MiniCPM-o adapter currently exposes neither structured function calls nor
client-triggered responses. The example therefore disables typed input,
on-demand inspection, and observation controls for this provider. It does not
simulate these features or silently fall back to a cloud service. See the
[MiniCPM-o integration guide](../../docs/voice-frontends/minicpm-o.md).

The Qwen configuration accepts `qwen3.5-omni-plus-realtime` (default) and
`qwen3.5-omni-flash-realtime`. Flash uses the same adapter; the live-service
validation recorded here applies to Plus.

## Quick start

Use a source checkout and the Node.js version in the repository's `.nvmrc`.
From the repository root:

```bash
npm ci
cp examples/x-omni/.env.example examples/x-omni/.env.local
```

For the default Qwen configuration, set the following in `.env.local`:

```dotenv
QWEN_AUDIO_REALTIME_PROVIDER=dashscope
QWEN_AUDIO_REALTIME_MODEL=qwen3.5-omni-plus-realtime
DASHSCOPE_API_KEY=your-key
AGENT_PROTOCOL=none
```

Start the example:

```bash
npm run example:x-omni
```

Open **http://127.0.0.1:5178**. The example owns a separate localhost Gateway on
port **18890**. Its default configuration, state, and memory live under the
git-ignored `examples/x-omni/.runtime/`; it does not connect to the desktop
Gateway. Explicit `QWAUDIO_*` directory overrides still apply.

Credentials stay in Node.js, never in the browser bundle. For DashScope,
`QWEN_AUDIO_REALTIME_BASE_URL` optionally changes the WebSocket endpoint for
both conversation and the visual reader.

### MiniCPM-o configuration

Install and start MiniCPM-o separately using its
[official deployment instructions](https://github.com/OpenBMB/MiniCPM-o-Demo).
Replace the provider configuration in `.env.local` with:

```dotenv
QWEN_AUDIO_REALTIME_PROVIDER=minicpm-o
MINICPM_O_REALTIME_URL=ws://127.0.0.1:8006/v1/realtime?mode=video
AGENT_PROTOCOL=none
# MINICPM_O_AUTH_TOKEN=your-token
```

Use the actual endpoint of your deployment; the local URL above assumes HTTP
mode on loopback. Set `MINICPM_O_AUTH_TOKEN` only if the service requires one.
No DashScope key is required. Start the same command, select a visual source,
and enable the microphone. The client automatically uses **Continuous frames**.
The example does not install, start, or manage model inference services.

### Optional backend

The default is frontend-only (`AGENT_PROTOCOL=none`). To try backend work, set
`AGENT_PROTOCOL=qwen`, for example, after installing and configuring Qwen Code
yourself. Backend permissions and model selection follow the framework's
existing behavior. No Agent is installed by this example.

## Usage

The following workflow describes the full Qwen configuration. With MiniCPM-o,
use source selection and continuous audiovisual conversation; tool-based
steps and typed requests are unavailable.

1. Choose **Camera**, **Share screen**, or **Open image**, granting permission
   only for the source you want to inspect.
2. In **On-demand capture**, ask “What is in the current image?” by text or
   enable the microphone and speak. Preview alone does not upload frames.
3. In **Continuous frames**, enable the microphone. One JPEG per second goes
   to the main Omni conversation, associated with its audio timeline.
4. Ask “Watch this progress bar for two minutes; tell me when it finishes.”
   Or “For the next minute, describe meaningful changes in the picture.”
5. Say “Stop watching”, use **Stop all observations**, or close the source.
   Use **Observation status** to check actual running/failed observations.
6. With a backend configured, try “Read the current screen, then ask the
   backend to explain this error using the captured image.”

Screen sharing depends on browser support and OS permissions. Start on desktop
Chrome/Edge via localhost; this is not a packaged desktop/mobile application.
Microphone mute does not cancel an explicitly started visual observation.
Closing/changing the source, switching capture mode, disconnecting the page,
or stopping the example cancels observations. Reload creates a new conversation.

## Architecture and boundaries

| Component | Responsibility |
| --- | --- |
| `client/` | Source permission, preview, JPEG capture, and shared WebUI voice runtime. |
| `gateway.mjs` | Resolves the configured Provider; registers supported example tools, capture action, and source-state event. |
| `vision/features.mjs` | Central capability policy used by both the host and UI. |
| `vision/tools.mjs` | `capture_visual` and `visual_observation`; small textual results and attachment references. |
| `vision/dashscope-reader.mjs` | Provider-specific visual reader; a short-lived, text-only Qwen Omni connection per inspection. |
| `vision/observers.mjs` | Sampling, edge/cooldown policy, cancellation, and Agent Delivery notifications. |

Continuous frames go through the Gateway's configured Realtime adapter to the
main conversation. On-demand inspection in the Qwen configuration
uses a **separate visual reader**, then returns its textual observation to the
main conversation. The main model receives a textual tool result, while the
original image is processed by the reader and registered as an attachment.
The reader sends synthetic silent PCM with one JPEG and performs a
manual commit. It never changes the main conversation's VAD or commits the
user's live microphone. See the official
[Omni client events](https://help.aliyun.com/zh/model-studio/client-events).

Observation uses the same reader, not the coordinating backend Session. A
notification enters the existing Agent Delivery response queue; ordinary
conversation keeps its turn/interrupt rules. Queued notifications check
cancellation and expiry before generating a reply. Speech already playing
cannot be retroactively withdrawn.

The generic host extension is intentionally small:

- `createGatewayApplication({ frontendToolSources, clientActionNames })`.
- Each source follows the existing `describe/initialize/tools/execute/health/close`
  lifecycle. `execute(name, args, context)` receives a connection-scoped
  `signal`, identity, `turnId`, `isCurrent()`, `supportsClientAction()`,
  `requestClientAction()`, `registerInputs()`, and `deliver()`.
- The browser advertises `client.actions.xomni.visual.capture` and answers
  `client.action.request`; `xomni.visual.state` updates context without speaking.

No visual scenario is added to the global prompt, protocol event enumeration,
or backend adapters. The example imports the same checkout's WebUI hook and
camera encoder rather than copying an audio/vision transport implementation.
It uses WebSocket transport, not WebRTC.

### Integrating another Omni service

Reuse or implement a framework Realtime Provider adapter and declare its actual
model and transport capabilities. Continuous vision uses the existing
`input_image_buffer.append` Gateway message; the provider adapter owns wire
format conversion. A model name alone cannot make an incompatible API work.

For tool-driven inspection and observation, add a reader inside `vision/` with
`read(frame, question, { signal, structured })` and `close()`. Plain reads return
text; structured reads return `{ match: boolean, summary: string }`. Wire it
in `gateway.mjs` and update `vision/features.mjs` only after validating the
main frontend's tool calls and proactive replies. Capture and scheduling stay
provider-independent; do not put another provider's protocol in the UI or reuse
the DashScope reader against an incompatible endpoint.

## Limits, privacy, and cost

- Preview is local. On-demand frames, continuous frames, and observation samples
  are sent to the configured services only as described above. With MiniCPM-o,
  frames go only to its configured endpoint; no DashScope reader is created.
- Visual-reader requests incur **additional inference cost and latency**.
  Up to two requests and two observations run concurrently. Sampling is every
  10 seconds after an initial sample; observations default to 120 seconds and
  allow 10–600 seconds. There is no unbounded retry/reconnection loop.
- A condition notifies once by default. Repeated conditions require a false-to-true
  transition and at least 20 seconds between notifications. Narration suppresses
  identical summaries and asks the model to report only meaningful changes;
  semantic duplicate suppression is not guaranteed.
- Source changes, stale frames, invalid structured responses, and inference
  failures fail closed. Inspect observation status and restart explicitly.
- Frames are bounded JPEGs (190 KiB). Captures are not written to disk by this
  example; attachment references live in Gateway memory. Text conversation and
  observations may enter normal session history. A backend receiving an image
  may persist it according to its own behavior.
- No audio observation, video recording, safety-critical alarms, autonomous
  computer control, or access to an unselected camera/screen. Sampled vision can
  miss brief events; model judgments can be wrong.
- Keep clocks synchronized when running browser and Gateway on different hosts;
  stale capture timestamps are rejected. Remote deployment requires HTTPS and
  the framework's authentication/origin configuration.

## Development

```bash
npm run test:x-omni
npm run example:x-omni:build
npx eslint examples/x-omni
npx playwright install chromium
npm run test:x-omni-browser
```

Tests use synthetic media and mocked model responses; no cloud key or real
camera is required. Browser checks require Playwright Chromium and cover both
the Qwen capture/tool round trip and MiniCPM-o video transport with unsupported
controls disabled. These tests verify integration, not model perception quality;
validate the actual service and chosen model before deployment.
