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

## Architecture

![Smart cockpit framework architecture](docs/framework-architecture.svg)

The base qwen-audio-agent boundary is foreground conversation plus backend
execution. The cockpit client and Gateway form the foreground, the cockpit
Agent handles backend tasks, and the Service supplies scenario state, business
rules, and the tool execution environment.

See the [architecture document](docs/architecture.md) for complete boundaries
and data flows.

## Benchmark Results

The benchmark evaluates cockpit tool calling with the same tools, prompt,
deterministic state, and scorer for Text and Realtime models.

### Short Suite

86 canonical cases across vehicle control, music, navigation, and weather.

| Domain | Cases | Expected calls | Text pass rate | Text actual calls | Realtime pass rate | Realtime actual calls |
|---|---:|---:|---:|---:|---:|---:|
| Vehicle | 24 | 23 | 100.00% | 23 | 100.00% | 23 |
| Music | 18 | 17 | 100.00% | 17 | 100.00% | 17 |
| Navigation | 36 | 44 | 100.00% | 44 | 97.22% | 44 |
| Weather | 8 | 8 | 100.00% | 8 | 100.00% | 8 |
| Overall | 86 | 92 | 100.00% | 92 | 98.84% | 92 |

### Long-Context Suite

10 mixed-domain conversations, 500 total turns, 250 expected tool calls, and
250 no-tool chitchat/background turns. Long-context results focus on call-level,
state, and no-tool behavior instead of task pass rate.

| Model | Calls exp/act | Tool acc | Aligned tool | Arg acc | Aligned arg | Missing/extra | Final state | Checkpoints | Silent turns |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Text `qwen3.8-flash` | 250 / 252 | 88.80% | 100.00% | 91.20% | 100.00% | 0 / 2 | 100.00% | 100.00% | 90.00% |
| Realtime `qwen-audio-3.0-realtime-plus` | 250 / 246 | 71.20% | 98.40% | 76.00% | 98.40% | 4 / 0 | 100.00% | 80.00% | 100.00% |

See the [Benchmark guide](bench/README.md) for datasets, commands, alignment
metrics, timeout retry behavior, and scoring rules.

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

The Realtime model sees the function-tool surface assembled by the Gateway:
the foreground MCP tools above, Gateway built-ins, and capability-gated tools.

| Function tool source | Count | Tools |
|---|---:|---|
| Gateway built-ins, default | 7 | `spawn_thinking`, `schedule_reminder`, `cancel_agent_task`, `get_agent_task_status`, `get_current_time`, `memory`, `notes` |
| Gateway built-ins, conditional | up to +7 | `knowledge`, `recall`, `respond_permission`, `respond_agent_input`, `web_search`, `fetch_url`, `enter_sleep`; visible only when the matching knowledge, session digest, retrieval, pending permission, pending input, or client sleep action capability exists |
| Cockpit foreground MCP tools | 34 | `vehicle`, `navigation`, `music`, and `weather` tools routed to the foreground; model-visible names are `mcp__cockpit__*` |
| **Default Realtime total** | **41** | 7 Gateway built-ins + 34 cockpit foreground MCP tools |

By default, `vehicle`, `navigation`, `music`, and `weather` use the foreground
Realtime fast path, while `flashbuy` and `custom-skills` run through the backend
Agent. Change the scenario routing in
[`surface-routing.json`](service/tools/surface-routing.json); see the
[tool directory guide](service/tools/README.md) for extension details.

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
