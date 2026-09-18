# Qwen Audio Agent X-Omni Example

English | [中文](README_ZH.md)

A standalone multimodal conversation example using Qwen3.5 Omni Realtime:
talk about a camera, a shared screen, or an image; explicitly ask it to watch
for a visible condition or narrate changes while conversation continues.
Visual tools, capture policy, and observation scheduling live here, not in the
standard desktop client or the Gateway's built-in prompt.

## Core features

- **Phase 1 — visual conversation:** camera/screen selection, image loading,
  continuous frames, and on-demand inspection.
- **Phase 2 — optional observation:** bounded condition reminders and change
  narration, with cancellation, deduplication, deadlines, and concurrency limits.
- **Existing conversation runtime:** reuses the WebUI voice hook and Gateway
  Client Protocol for audio, interruption, playback receipts, and client actions.
- **Optional backend:** captured images have ordinary `input_N` references that
  `spawn_thinking` can pass to an installed backend; observation itself needs no backend.

## Quick start

Use a source checkout and the Node.js version in the repository's `.nvmrc`.
From the repository root:

```bash
npm ci
cp examples/x-omni/.env.example examples/x-omni/.env.local
```

Set `DASHSCOPE_API_KEY` in that file, then run:

```bash
npm run example:x-omni
```

Open **http://127.0.0.1:5178**. The example owns a separate localhost Gateway on
port **18890**. Its default configuration, state, and memory live under the
git-ignored `examples/x-omni/.runtime/`; it does not connect to the desktop
Gateway. Explicit `QWAUDIO_*` directory overrides still apply.

The key stays in Node.js, never in the browser bundle. Supported models are
`qwen3.5-omni-plus-realtime` (default) and `qwen3.5-omni-flash-realtime`.
An optional `QWEN_AUDIO_REALTIME_BASE_URL` changes the Omni WebSocket endpoint
for both conversation and the visual reader.

The default is frontend-only (`AGENT_PROTOCOL=none`). To try backend work, set
`AGENT_PROTOCOL=qwen`, for example, after installing and configuring Qwen Code
yourself. Backend permissions and model selection follow the framework's
existing behavior. No Agent is installed by this example.

## Try it

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
| `gateway.mjs` | Registers example tools, the capture action, and source-state event. |
| `vision/tools.mjs` | `capture_visual` and `visual_observation`; small textual results and attachment references. |
| `vision/omni-reader.mjs` | A short-lived, text-only Omni connection per inspection. |
| `vision/observers.mjs` | Sampling, edge/cooldown policy, cancellation, and Agent Delivery notifications. |

Continuous frames go directly to the main Omni session. On-demand inspection
uses a **separate visual reader**, then returns its textual observation to the
main conversation; the main model is not secretly given pixels via a tool-result
string. The reader sends synthetic silent PCM with one JPEG and performs a
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

## Limits, privacy, and cost

- Preview is local. On-demand frames, continuous frames, and observation samples
  are sent to the configured Omni service only as described above.
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
camera is required. Browser checks additionally require Playwright Chromium.
Cloud model behavior must also be checked manually before relying on a deployment.
