# Smart Cockpit

Smart Cockpit is a runnable qwen-audio-agent scenario example. Users can
naturally control the vehicle, plan routes, play music, check the weather,
place flash-buy orders, and run custom workflows while the cockpit UI reflects
vehicle and task state.

## Demo

Use natural voice to start vehicle-control and navigation tasks, showing how
foreground realtime conversation, backend Agent execution, and cockpit UI state
work together.

<video controls preload="metadata" style="width: 100%; border-radius: 12px;">
  <source src="https://github.com/user-attachments/assets/0136b6ec-2ff8-49ba-8f07-55e7006d2e7d" type="video/mp4">
</video>

## Core features

- Continuous conversation, natural interruption, multi-turn context, and
  runtime voice and persona switching.
- MCP-based vehicle control, navigation, music, weather, flash-buy, and custom
  workflow tools.
- A foreground Realtime fast path for low-latency operations and a backend
  Agent for flash-buy and custom workflow tasks.
- A replaceable backend Agent connected through A2A 1.0, with ACP and custom
  adapters available as alternatives.
- Scenario-owned HTTP/SSE channels for vehicle, route, music, and order state.

## Architecture

![Smart cockpit framework architecture](https://raw.githubusercontent.com/QwenAudio/qwen-audio-agent/main/examples/smart-cockpit/docs/framework-architecture.svg)

The base qwen-audio-agent boundary is foreground conversation plus backend
execution. The cockpit client and Gateway form the foreground, the cockpit Agent
handles backend tasks, and the Service supplies scenario state, business rules,
and the tool execution environment.

| Component | Example implementation | Main interfaces |
|---|---|---|
| `client/` | React cockpit UI + Browser Audio | GCP 6.0 / Gateway Client SDK |
| `gateway/` | qwen-audio-agent Gateway + foreground Realtime Agent | GCP / MCP / BackendPort |
| `agent/` | Qwen3.8-Flash backend Agent | A2A 1.0 / MCP |
| `service/` | Cockpit state, rules, tools, and external integrations | HTTP/SSE / MCP |

See
[`examples/smart-cockpit/docs/architecture.md`](https://github.com/QwenAudio/qwen-audio-agent/blob/main/examples/smart-cockpit/docs/architecture.md)
for complete boundaries and data flows.

## Tool calling

The cockpit Service provides 38 MCP tools across six scenario domains:

| Domain | Count | Main capabilities |
|---|---:|---|
| `vehicle` | 11 | Location and state, climate, windows, lights, charging, and other controls. |
| `navigation` | 12 | Place search, routing, waypoints, favorites, and route preferences. |
| `music` | 10 | Search, playback, previous/next track, volume, media source, and favorites. |
| `weather` | 1 | City weather lookup. |
| `flashbuy` | 1 | Flash-buy product search and ordering demonstration. |
| `custom-skills` | 3 | List, create, and load user-defined workflows. |

By default, vehicle, navigation, music, and weather use the foreground Realtime
fast path, while flash-buy and custom skills run through the backend Agent.
Scenario developers can change this routing in `service/tools/surface-routing.json`.

## Run the example

```bash
cp examples/smart-cockpit/.env.example examples/smart-cockpit/.env.local
# Set DASHSCOPE_API_KEY in .env.local; map keys are optional.
npm run example:smart-cockpit:install
npm run example:smart-cockpit
```

Open `http://localhost:5173`. The command starts service, agent, gateway, and
client together.

## Benchmark

The cockpit benchmark compares text and Realtime model tool calling with the
same tools, prompt, deterministic cockpit state, and scorer. It measures tool
selection, arguments, execution-path routing, and final state.

- Short suite: 86 cases across vehicle, navigation, music, and weather.
- Long-context suite: 10 mixed-domain conversations and 500 total turns,
  including 250 expected tool calls and 250 no-tool turns.
- Runners: Gold Replay, text model, controlled Realtime model, and the complete
  Realtime voice path.

```bash
node examples/smart-cockpit/bench/runner/run-gold.mjs
node examples/smart-cockpit/bench/runner/run-text.mjs
node examples/smart-cockpit/bench/runner/run-realtime.mjs
node examples/smart-cockpit/bench/runner/run-voice.mjs
```

See
[`examples/smart-cockpit/bench/README.md`](https://github.com/QwenAudio/qwen-audio-agent/blob/main/examples/smart-cockpit/bench/README.md)
for the latest results, datasets, and scoring details.

## Replace and extend

| Goal | Change |
|---|---|
| Replace the cockpit UI or audio I/O | `client/` |
| Replace the backend Agent | Change `COCKPIT_AGENT_CARD_URL` or replace `agent/` |
| Add scenario tools, state, or external services | `service/` and `service/tools/` |
| Change foreground personas or backend-task semantics | `gateway/` |

See the
[component replacement guide](https://github.com/QwenAudio/qwen-audio-agent/blob/main/examples/smart-cockpit/docs/replacing-components.md)
for the complete migration path.

## Authors and acknowledgements

- [Zhang Binbin](https://github.com/robin1001): designed and expanded the
  cockpit domain capabilities, including navigation, vehicle-control and music
  tools, foreground/backend routing, and evaluation cases.
- [Li Xu](https://github.com/x-lixu): designed and implemented the scenario on
  qwen-audio-agent, including the client, Gateway and backend Agent boundaries,
  realtime voice path, and A2A/MCP integrations.
- [Peng Zhendong](https://github.com/pengzhendong): provided the original
  cockpit UI and visual assets, including the overall interface design,
  interaction patterns, and related visual materials.
