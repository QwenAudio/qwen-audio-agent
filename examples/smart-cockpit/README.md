# Qwen Audio Agent Smart Cockpit Example

English | [中文](README_ZH.md)

This runnable smart-cockpit Agent example is built with qwen-audio-agent. Users
can naturally control the vehicle, plan routes, play music, check the weather,
place flash-buy orders, and run custom workflows while the cockpit UI reflects
vehicle and task state. It shows how to combine foreground realtime conversation,
tool calling, and a replaceable backend Agent with the framework.

## Demo

Use natural voice to start vehicle-control and navigation tasks, showing how
realtime foreground conversation, backend Agent execution, and cockpit UI state
work together.

> Turn on sound for the full experience.

https://github.com/user-attachments/assets/0136b6ec-2ff8-49ba-8f07-55e7006d2e7d

## Core features

- **Realtime voice conversation:** continuous dialogue, natural interruption,
  multi-turn context, and runtime voice and persona switching.
- **Standard tool calling:** vehicle control, navigation, music, weather,
  flash-buy, and custom workflows are exposed as MCP tools.
- **Foreground/backend routing:** low-latency operations run directly in the
  foreground Realtime path; flash-buy and custom workflows go to the backend Agent.
- **Standard backend integration:** the example Agent connects through A2A 1.0
  and can be replaced by a customer-owned A2A, ACP, or custom backend.
- **Scenario-state projection:** the cockpit UI receives vehicle, route, music,
  and order state through scenario-owned HTTP/SSE channels.
- **Replaceable components:** the client, backend Agent, and scenario service can
  each be replaced without changing the framework core.

## Architecture

![Smart cockpit framework architecture](docs/framework-architecture.svg)

The base qwen-audio-agent boundary is foreground conversation plus backend
execution. The cockpit client and Gateway form the foreground, the cockpit Agent
handles backend tasks, and the Service supplies scenario state, business rules,
and the tool execution environment.

| Directory / process | Default address | Responsibility |
|---|---|---|
| [`client/`](client/) / cockpit-client | `http://127.0.0.1:5173` | Replaceable cockpit client responsible for audio I/O, conversation interaction, and business panels. |
| [`gateway/`](gateway/) / cockpit-gateway | `http://127.0.0.1:18888` | Foreground Agent and Gateway composition for realtime conversation, foreground tools, and backend task submission. |
| [`agent/`](agent/) / cockpit-agent | `http://127.0.0.1:3020` | Replaceable A2A backend Agent; Qwen3.8-Flash interprets and orchestrates tasks. |
| [`service/`](service/) / cockpit-service | `http://127.0.0.1:3010` | Cockpit environment and infrastructure for state, rules, external integrations, and MCP tools. |
| [`bootstrap/`](bootstrap/) | — | Shared environment loading and startup preflight for all four processes. |

See the [architecture document](docs/architecture.md) for complete boundaries
and data flows.

## Quick start

From the repository root:

```bash
cp examples/smart-cockpit/.env.example examples/smart-cockpit/.env.local
```

Set at least:

```dotenv
DASHSCOPE_API_KEY=your_dashscope_api_key
```

Optionally configure `VITE_AMAP_KEY`, `VITE_AMAP_SECRET`, and `AMAP_MCP_KEY`
for AMap rendering and route services. Then install dependencies and start the
example:

```bash
npm run example:smart-cockpit:install
npm run example:smart-cockpit
```

Open `http://localhost:5173`. Press `Ctrl+C` to stop all example processes.

## Tool calling

The cockpit Service provides 38 tools across six scenario domains. Tool
definitions, executors, and foreground/backend routing remain independent.

| Domain | Count | Example capabilities |
|---|---:|---|
| `vehicle` | 11 | Vehicle location and state, climate, windows, sunroof, lights, charging, and other controls. |
| `navigation` | 12 | Place search, routing, ordered waypoints, favorites, route preferences, and stop-navigation. |
| `music` | 10 | Search and playback, previous/next track, volume, media source, and favorites. |
| `weather` | 1 | City weather lookup. |
| `flashbuy` | 1 | Flash-buy product search and ordering demonstration. |
| `custom-skills` | 3 | List, create, and load user-defined cockpit workflows. |
| **Total** | **38** | Foreground low-latency operations and backend composed tasks. |

By default, `vehicle`, `navigation`, `music`, and `weather` use the foreground
Realtime fast path, while `flashbuy` and `custom-skills` run through the backend
Agent. Change the scenario routing in
[`surface-routing.json`](service/tools/surface-routing.json); see the
[tool directory guide](service/tools/README.md) for extension details.

## Benchmark

The example includes a reproducible cockpit tool-calling benchmark. It uses the
same tools, prompt, deterministic state, and scorer to evaluate tool selection,
argument generation, and no-tool decisions in both single-turn and long-context
conversations:

- Short suite: 86 cockpit instructions.
- Long-context suite: 10 conversations and 500 turns, including 250 expected
  tool calls and 250 no-tool turns.
- Four runners: Gold, text model, controlled Realtime, and full voice pipeline.

```bash
node examples/smart-cockpit/bench/runner/run-gold.mjs
node examples/smart-cockpit/bench/runner/run-text.mjs
node examples/smart-cockpit/bench/runner/run-realtime.mjs
node examples/smart-cockpit/bench/runner/run-voice.mjs
```

See the [Benchmark guide](bench/README.md) for datasets, runtime options, and
scoring rules.

## Replace and extend

| Goal | Change |
|---|---|
| Replace the cockpit UI or audio I/O | [`client/`](client/) |
| Replace the backend Agent | Change `COCKPIT_AGENT_CARD_URL` or replace [`agent/`](agent/) |
| Add scenario tools, state, or external services | [`service/`](service/) and [`service/tools/`](service/tools/) |
| Change foreground personas or backend-task semantics | [`gateway/`](gateway/) |
| Change foreground/backend tool routing | [`surface-routing.json`](service/tools/surface-routing.json) |

See the [component replacement guide](docs/replacing-components.md) for the
complete migration path.

## Authors and acknowledgements

- [Zhang Binbin](https://github.com/robin1001): designed and expanded the
  cockpit domain capabilities, including the navigation, vehicle-control and
  music tool suites, foreground/backend routing, and evaluation cases.
- [Li Xu](https://github.com/x-lixu): designed and implemented the scenario on
  qwen-audio-agent, including the client, Gateway and backend Agent boundaries,
  the realtime voice path, and the A2A/MCP integrations.
- [Peng Zhendong](https://github.com/pengzhendong): provided the original
  cockpit UI and visual assets, including the overall interface design,
  interaction patterns, and related visual materials.
