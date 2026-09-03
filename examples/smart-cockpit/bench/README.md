# Smart Cockpit Benchmark

This folder defines a tau-bench-style benchmark for the smart cockpit example.
It evaluates vehicle control, music, navigation, and weather function calling
with one shared tool set, multi-turn context, path selection, state outcomes,
and pre-command chitchat.

## Dataset

The benchmark currently contains 86 canonical text cases:

| Domain | Case file | Cases | Expected tool calls | Negative cases |
| --- | --- | ---: | ---: | ---: |
| Vehicle | `cases/vehicle.jsonl` | 24 | 23 | 1 |
| Music | `cases/music.jsonl` | 18 | 17 | 1 |
| Navigation | `cases/navigation.jsonl` | 36 | 44 | 3 |
| Weather | `cases/weather.jsonl` | 8 | 8 | 0 |
| Total |  | 86 | 92 | 5 |

- single-turn vehicle, music, navigation, and weather commands
- route preview and place search
- favorite-address setup and navigation
- active-route updates for waypoints, destination, strategy, voice, and view
- music playback, source, volume, and favorite controls
- vehicle climate, window, closure, light, horn, seat, and charge controls
- weather lookup and simple advice requests
- pre-chitchat cases with entity and cross-domain distractors
- negative cases that should clarify or avoid mutating state

Navigation cases include:

- single-turn navigation commands
- route preview and place search
- favorite-address setup and navigation
- active-route updates for waypoints, destination, strategy, voice, and view
- pre-chitchat cases with entity and cross-domain distractors
- negative cases that should clarify or avoid mutating navigation state

Each case records:

- `turns`: canonical user text, later reused by text and voice runners
- `setup_calls`: deterministic cockpit state setup before the case starts
- `expected_calls`: expected tool calls; runners rewrite the expected
  `frontend` or `backend` path from the active domain routing
- `exact_arguments`: optional per-call flag for tools where extra arguments
  change behavior
- `expected_final_state`: dotted state assertions after execution
- `forbidden_calls_before_turn`: guardrail for chitchat turns
- `response_quality`: optional semantic rubric for later response-quality
  judging; it is reported separately and does not affect the main action score

## Scoring

`evaluator/score.mjs` scores a collected trace on:

- full case pass rate for tool/state behavior
- total expected and actual tool calls
- expected and actual tool calls by tool domain
- per-case-domain summaries for vehicle, music, navigation, and weather
- tool selection accuracy
- argument accuracy
- path accuracy
- turn alignment
- final state success
- no-spurious-tool rate before the actionable turn
- no-extra-tool-call rate
- response-quality judge coverage/rate when a separate judge has evaluated
  `response_quality` rubrics

The evaluator accepts traces shaped like:

```json
{
  "calls": [
    {
      "turn_index": 0,
      "path": "backend",
      "name": "navigation_start",
      "arguments": { "destination": "西湖" }
    }
  ],
  "assistant_messages": ["已开始导航到西湖"],
  "final_state": {}
}
```

The active domain routing comes from `service/tools/surface-routing.json`,
`COCKPIT_TOOL_SURFACE_ROUTING`, or `COCKPIT_DOMAIN_SURFACES`. Reports include
the routing snapshot so path scores can be compared across configurations.

## Latest Results

These results are based on the existing full benchmark reports. After those
full runs, three ambiguous cases were corrected and validated with targeted
text and Realtime regression runs; no new full run was performed for
that final case text update.

| Domain | Cases | Expected calls | Text pass rate | Text actual calls | Realtime pass rate | Realtime actual calls |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Vehicle | 24 | 23 | 95.83% | 23 | 100.00% | 23 |
| Music | 18 | 17 | 100.00% | 17 | 94.44% | 18 |
| Navigation | 36 | 44 | 97.22% | 46 | 94.44% | 46 |
| Weather | 8 | 8 | 100.00% | 8 | 100.00% | 8 |
| Overall | 86 | 92 | 97.67% | 94 | 96.51% | 95 |

Gold replay passes all 86 cases with 92 expected and 92 actual tool calls,
confirming the dataset, deterministic service, and scorer are internally
consistent.

Known failures in the latest full text report:

- `veh_single_climate_start_003`: selected `vehicle_climate_control`, but used
  `action: "open"` instead of the expected `action: "start"`.
- `nav_context_change_destination_015`: made the expected navigation calls but
  also emitted duplicate extra navigation calls.

Known failures in the latest full Realtime report were tied to three
case definitions that were later revised:

- `mus_negative_unknown_source_018`
- `nav_context_route_status_019`
- `nav_chitchat_weather_then_search_029`

Each of those revised cases passes in both targeted text and targeted
Realtime regression runs.

## Gold Replay

Run a deterministic replay of the expected calls to sanity-check the dataset:

```bash
node examples/smart-cockpit/bench/runner/run-gold.mjs
```

To save the full report:

```bash
node examples/smart-cockpit/bench/runner/run-gold.mjs \
  --out examples/smart-cockpit/bench/reports/cockpit-gold-latest.json
```

## Text Model Run

Run the canonical cases through the DashScope cockpit text model with the same
cockpit prompt, tool definitions, deterministic service, and case setup used by
gold replay:

```bash
node examples/smart-cockpit/bench/runner/run-text.mjs
```

Useful options:

```bash
node examples/smart-cockpit/bench/runner/run-text.mjs --limit 5
node examples/smart-cockpit/bench/runner/run-text.mjs --case-id nav_single_start_001
node examples/smart-cockpit/bench/runner/run-text.mjs --domain navigation
node examples/smart-cockpit/bench/runner/run-text.mjs --model qwen3.8-flash
```

Reports are written to `reports/cockpit-text-latest.json` by default.

## Realtime Run

Run the same canonical cases through a Realtime model while keeping the tool
set, prompt, service implementation, and initial state fixed:

```bash
node examples/smart-cockpit/bench/runner/run-realtime.mjs
```

This runner connects directly to the configured Realtime provider, synthesizes
each `turns.user` text with macOS `say`, streams 16 kHz PCM audio to the model,
executes Realtime function calls against the deterministic benchmark service,
and scores the resulting trace with the same evaluator as text and gold. It
does not start the Gateway, A2A Agent, browser page, or production cockpit
service, so backend/page behavior changes do not move this score.

Useful options:

```bash
node examples/smart-cockpit/bench/runner/run-realtime.mjs --limit 3
node examples/smart-cockpit/bench/runner/run-realtime.mjs --case-id nav_single_start_001
node examples/smart-cockpit/bench/runner/run-realtime.mjs --domain navigation
node examples/smart-cockpit/bench/runner/run-realtime.mjs --realtime-model qwen-audio-3.0-realtime-flash
node examples/smart-cockpit/bench/runner/run-realtime.mjs --output text
node examples/smart-cockpit/bench/runner/run-realtime.mjs --say-voice Ting-Ting
```

Reports are written to
`reports/cockpit-realtime-latest.json` by default and include
redacted provider events for debugging ASR/realtime failures.

## Full Realtime Voice Run

Run the same navigation cases through the full cockpit Realtime path:

```bash
node examples/smart-cockpit/bench/runner/run-voice.mjs
```

The runner starts an in-process Cockpit Service, A2A Agent, and Gateway. Each
case resets the shared benchmark cockpit state, synthesizes the `turns.user`
text with macOS `say`, converts it to 16 kHz PCM with `ffmpeg`, streams audio
chunks to `/api/realtime`, records MCP calls from the frontend/backend surfaces,
and scores the trace with the same evaluator. Use this as an end-to-end
regression suite after the text/realtime score has isolated the model-side
capability.

Useful options:

```bash
node examples/smart-cockpit/bench/runner/run-voice.mjs --limit 3
node examples/smart-cockpit/bench/runner/run-voice.mjs --case-id nav_single_start_001
node examples/smart-cockpit/bench/runner/run-voice.mjs --realtime-model qwen-omni-turbo-realtime
node examples/smart-cockpit/bench/runner/run-voice.mjs --agent-model qwen3.8-flash
node examples/smart-cockpit/bench/runner/run-voice.mjs --say-voice Ting-Ting
```

Reports are written to
`reports/navigation-voice-realtime-latest.json` by default and include the raw
Gateway voice events for debugging ASR/realtime failures.
