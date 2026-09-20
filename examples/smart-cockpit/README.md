# Qwen Audio Agent Smart Cockpit Example

English | [中文](README_ZH.md)

This runnable smart-cockpit Agent example is built with qwen-audio-agent. Users
can naturally control the vehicle, plan routes, play music, check the weather,
place flash-buy orders, and use custom skills while the cockpit UI reflects
vehicle and task state. It shows how to combine foreground realtime conversation,
tool calling, and a replaceable backend Agent with the framework.

## Demo

The backend Agent retains up to 50 turns of task requests and final replies in
memory, so follow-up tasks can refer to earlier results. Each request includes
at most 49 previous turns plus the current turn; tool traces are not replayed.
The example Gateway reuses the server-issued A2A Context per owner while creating a new Task
for each request. Independent system tasks and other owners remain isolated.
Restarting the backend Agent clears this short-term history; it is separate from
the foreground's long-term memory and the Service's vehicle state.

Use natural voice for vehicle control and navigation, with cockpit UI updates.
Long-running background work can continue alongside foreground conversation.

> Turn on sound for the full experience.

https://github.com/user-attachments/assets/29375a62-d5d0-46e8-a963-e00118688002

## Architecture

![Smart cockpit framework architecture](docs/framework-architecture.svg)

The foreground supports both realtime conversation and direct tool calls;
long-running or backend-routed work goes to the cockpit Agent without blocking
conversation. The Service supplies shared scenario state, business rules, and
tool execution for both paths.

See the [architecture document](docs/architecture.md) for complete boundaries
and data flows.

## Benchmark Results

The accuracy benchmark covers vehicle control, music, navigation, and weather.
Flash-buy and custom skills are demonstrated separately, not scored by these suites.

| Suite | Test cases | Dialogue turns | Turns requiring tools | Tools covered by expected calls | Reported metric |
|---|---:|---:|---:|---:|---|
| Short | 86 | 111 (1–3 per case) | 92 | 34 | Full-case pass rate |
| Long dialogue | 10 | 500 (50 per case) | 250 | 22 | Per-turn tool-behavior accuracy |

The long suite uses separately designed conversations and a subset of the same
tool catalog. Its 500 turns include 250 no-tool turns. A dialogue turn is one
user input and its processing, not the number of steps needed to finish a task.

`Realtime-plus` means `qwen-audio-3.0-realtime-plus`; `+ Harness` evaluates the
complete Gateway/tool path with its production prompt and runtime guards,
not an identical-prompt model ablation.

### Short cases: full-case pass rate

A case passes only when its tool calls, parameters, turn/path assignments,
no-tool behavior, and specified state assertions all pass.

| Subject | Full-case pass rate |
|---|---:|
| Realtime-plus + Harness | 97.67% (84/86) |
| Realtime-plus | 95.35% (82/86) |
| Text qwen3.7-plus | 97.67% (84/86) |
| Text qwen3.8-flash | 98.84% (85/86) |
| Text qwen3.8-max | 95.35% (82/86) |

Source: the September 13 recorded results plus a separate qwen3.7-plus run.
See [domain scores and provenance](bench/results/accuracy.md#short-cases--full-case-pass).

### Long dialogue: per-turn tool behavior

Each turn is scored independently within its conversation: tool calls and
parameters must match without missing/extra calls; no-tool turns must make
zero calls. This metric excludes state assertions and spoken-response quality.

| Subject | Overall turn accuracy | Tool-required turn pass | No-tool turn correctness |
|---|---:|---:|---:|
| Realtime-plus + Harness | 99.80% (499/500) | 100.00% (250/250) | 99.60% (249/250) |
| Realtime-plus | 99.20% (496/500) | 98.40% (246/250) | 100.00% (250/250) |
| Text qwen3.7-plus | 98.40% (492/500) | 97.60% (244/250) | 99.20% (248/250) |
| Text qwen3.8-flash | 98.60% (493/500) | 98.80% (247/250) | 98.40% (246/250) |
| Text qwen3.8-max | 98.60% (493/500) | 98.00% (245/250) | 99.20% (248/250) |

Source: team-provided per-turn counts received on September 14; qwen3.7-plus
was rescored from its local trace. These are not converted legacy sequence
scores. The suite repeats utterances and alternates tool/no-tool turns at fixed
positions; it measures controlled scenario behavior. See
[run provenance](bench/results/accuracy.md#long-dialogue--per-turn-tool-behavior)
and [coverage limits](bench/README.md#coverage-limits).

### Tool-return latency: foreground vs. backend placement

Both routes keep `qwen-audio-3.0-realtime-plus` in the foreground; the delegated
route uses `qwen3.8-flash` in the backend. Time runs from the end of user speech
PCM to the last tool return, excluding subsequent MCP delivery, reply audio,
and physical vehicle actions.

| Tool placement | Mean tool-return latency (s) | Valid timing samples |
|---|---:|---:|
| Foreground direct | 1.480 | 90 |
| Backend delegated | 3.560 | 68 |

Source: the [September 11 timing report](bench/results/voice-surface-short-20260911.json.md).
Both routes use the same 92 tool-required test turns, but their valid samples
are counted separately and include failed returns. This is an unpaired
tool-placement comparison, not a comparison of standalone model speed.

These summaries mirror the [accuracy results](bench/results/accuracy.md) and
timing report, with consistency checked by tests. Some accuracy runs still lack
published raw traces and complete settings; see the results page for provenance
and the [Benchmark guide](bench/README.md) for definitions and reproduction.
Earlier runs and sequence/alignment diagnostics remain in the
[history archive](bench/results/accuracy-history.md), not the headline tables.

## Core features

- **Realtime voice conversation:** continuous dialogue, natural interruption,
  multi-turn context, and runtime voice and persona switching.
- **Standard tool calling:** vehicle control, navigation, music, weather,
  flash-buy, and custom skills are exposed as MCP tools.
- **Foreground/backend routing:** low-latency operations run directly in the
  foreground Realtime path, including custom-skill creation and loading;
  flash-buy and multi-source news research go to the backend Agent.
- **Standard backend integration:** the example Agent connects through A2A 1.0
  and can be replaced by a customer-owned A2A, ACP, or custom backend.
- **Scenario-state projection:** the cockpit UI receives vehicle, route, music,
  and order state through scenario-owned HTTP/SSE channels.
- **Replaceable components:** the client, backend Agent, and scenario service can
  each be replaced without changing the framework core.

## Interaction paths

- Several foreground tool calls in one model response finish before one combined
  spoken response. Foreground MCP calls default to a 10-second timeout; a failure
  is reported rather than treated as a completed operation.
- Screen route-preference changes silently enter conversation context through a
  scenario event. The assistant can explain the selected preference without
  confusing it with the road the vehicle is actually on.
- Users can save a temperature-reminder rule by voice, then change the climate
  setpoint with the UI `−` / `+` controls. A reminder fires only when the value
  enters the saved range from outside, not repeatedly while it stays inside.
- Memory uses the standard Markdown memory tools and prompt policy; no separate
  cockpit-specific memory protocol is introduced.
- A news-report request runs asynchronously while conversation continues. The
  backend searches and reads sources, returns the full report as an A2A text
  artifact and a short spoken summary, and preserves dates and verification
  limits. Missing evidence is not replaced with model-generated “latest news”.

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

See the [recording checklist (Chinese)](docs/demo-recording.zh.md) for six voice, context, skill, and memory scenarios and their acceptance criteria.

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
| `custom-skills` | 3 | List, create/update, and load user workflows or structured temperature-reminder rules. |
| **Total** | **38** | Foreground low-latency operations and backend composed tasks. |

The Realtime model sees the function-tool surface assembled by the Gateway:
the foreground MCP tools above, Gateway built-ins, and capability-gated tools.

| Function tool source | Count | Tools |
|---|---:|---|
| Gateway built-ins, default | 7 | `spawn_thinking`, `schedule_reminder`, `cancel_agent_task`, `get_agent_task_status`, `get_current_time`, `memory`, `notes` |
| Gateway built-ins, conditional | up to +7 | `knowledge`, `recall`, `respond_permission`, `respond_agent_input`, `web_search`, `fetch_url`, `enter_sleep`; visible only when the matching knowledge, session digest, retrieval, pending permission, pending input, or client sleep action capability exists |
| Cockpit foreground MCP tools | 37 | `vehicle`, `navigation`, `music`, `weather`, and the 3 `custom-skills` tools; model-visible names are `mcp__cockpit__*` |
| **Default Realtime base total** | **44** | 7 Gateway built-ins + 37 cockpit foreground MCP tools, before conditional tools |

By default, `vehicle`, `navigation`, `music`, `weather`, and `custom-skills` use
the foreground Realtime path; only `flashbuy` uses the backend Service surface.
The foreground loads workflows and executes their foreground steps directly,
delegating only steps that need backend capabilities. Change domain routing in
[`surface-routing.json`](service/tools/surface-routing.json); see the
[tool directory guide](service/tools/README.md) for extension details.

The backend Agent additionally composes the framework's `web_search` and
`fetch_url` through `qwen-audio-agent/web-retrieval`: 1 Service tool + 2 retrieval
tools by default. These two retrieval tools are not part of the 38 scenario
tools. Search uses the same provider configuration as the frontend; the default
keyless search is an experimental fallback, so verify provider access before a
live demo. See [web-search configuration](../../docs/guides/web-search.md).

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
- [Kong Yuxiang](https://github.com/usionkong): ran the accuracy and timing
  benchmarks, including the short/long suite measurements across the text,
  realtime, and full-stack harness paths.
