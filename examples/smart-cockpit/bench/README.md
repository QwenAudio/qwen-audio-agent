# Smart Cockpit Benchmark

This benchmark evaluates smart-cockpit function calling across vehicle
control, music, navigation, and weather. Text and Realtime are evaluated with
the same tool set, prompt, deterministic service, initial state, and scoring
logic.

## Latest Results

### Short Suite

The short suite contains 86 canonical cases across four domains. The table
keeps the domain breakdown because each short-suite case belongs to one primary
domain.

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

Known failures in the latest full Realtime report were tied to three case
definitions that were later revised:

- `mus_negative_unknown_source_018`
- `nav_context_route_status_019`
- `nav_chitchat_weather_then_search_029`

Each revised case passes in both targeted text and targeted Realtime
regression runs.

### Long-Context Suite

The long-context suite contains 10 mixed-domain conversations, 500 total
conversation turns, 250 expected tool calls, and 250 no-tool chitchat or
background turns. Because every case is mixed-domain, the table only shows core
overall metrics.

These results were rescored from the existing traces after adding sequence
alignment; no model rerun was performed for that rescoring.

| Model | Calls exp/act | Pass | Tool acc | Aligned tool | Arg acc | Aligned arg | Missing/extra | Final state | Silent turns |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Text `qwen3.8-flash` | 250 / 250 | 30.00% | 75.60% | 98.80% | 78.80% | 96.80% | 3 / 3 | 80.00% | 90.00% |
| Realtime `qwen-audio-3.0-realtime-plus` | 250 / 216 | 0.00% | 60.80% | 86.00% | 64.80% | 82.80% | 35 / 1 | 80.00% | 100.00% |

Gold replay passes the long suite with 10/10 cases and 250/250 tool calls. The
combined `--suite all` gold replay passes 96/96 cases with 342/342 tool calls.

The long-context text failures are mostly sequence drift after a missed or
extra action: strict index-based tool selection is 75.60%, while same-tool
sequence alignment recovers to 98.80%. One text case also triggered a tool on a
turn marked `expect_no_tool`.

The long-context Realtime run shows stronger degradation: it did not trigger
tools on silent turns, but alignment still reports 35 missing expected calls,
lower argument accuracy, and several cases hit turn timeout before completing
the full 50-turn script.

## Quick Run

Run gold replay to sanity-check the dataset:

```bash
node examples/smart-cockpit/bench/runner/run-gold.mjs
node examples/smart-cockpit/bench/runner/run-gold.mjs --suite long
node examples/smart-cockpit/bench/runner/run-gold.mjs --suite all
```

Run the text benchmark:

```bash
node examples/smart-cockpit/bench/runner/run-text.mjs
node examples/smart-cockpit/bench/runner/run-text.mjs --suite long
node examples/smart-cockpit/bench/runner/run-text.mjs --domain navigation
node examples/smart-cockpit/bench/runner/run-text.mjs --model qwen3.8-flash
```

Run the controlled Realtime benchmark:

```bash
node examples/smart-cockpit/bench/runner/run-realtime.mjs
node examples/smart-cockpit/bench/runner/run-realtime.mjs --suite long
node examples/smart-cockpit/bench/runner/run-realtime.mjs --domain navigation
node examples/smart-cockpit/bench/runner/run-realtime.mjs --realtime-model qwen-audio-3.0-realtime-flash
```

Reports are written under `reports/`.

## Dataset

The default short benchmark contains 86 canonical cases:

| Domain | Case file | Cases | Expected tool calls | Negative cases |
| --- | --- | ---: | ---: | ---: |
| Vehicle | `cases/vehicle.jsonl` | 24 | 23 | 1 |
| Music | `cases/music.jsonl` | 18 | 17 | 1 |
| Navigation | `cases/navigation.jsonl` | 36 | 44 | 3 |
| Weather | `cases/weather.jsonl` | 8 | 8 | 0 |
| Total |  | 86 | 92 | 5 |

The mixed long-context suite adds 10 multi-domain conversations in
`cases/mixed-long-context.jsonl`. Each case has 50 turns: 25 actionable turns
with expected tool calls and 25 no-tool turns for chitchat, background,
emotion, or distractor mentions.

| Suite | Cases | Turns per case | Expected tool calls | No-tool turns |
| --- | ---: | ---: | ---: | ---: |
| Short | 86 | 1-3 | 92 | Case-specific |
| Long mixed | 10 | 50 | 250 | 250 total |
| All | 96 | Mixed | 342 | Mixed |

The dataset covers:

- single-turn vehicle, music, navigation, and weather commands
- route preview and place search
- favorite-address setup and navigation
- active-route updates for waypoints, destination, strategy, voice, and view
- music playback, source, volume, and favorite controls
- vehicle climate, window, closure, light, horn, seat, and charge controls
- weather lookup and simple advice requests
- pre-chitchat cases with entity and cross-domain distractors
- negative cases that should clarify or avoid mutating state
- long mixed-domain sessions that interleave chitchat, vehicle control, music,
  navigation, and weather over about 50 turns

Each case records:

- `turns`: canonical user text, later reused by text and voice runners
- `turns[].expect_no_tool`: marks chitchat or background turns where any tool
  call is spurious
- `setup_calls`: deterministic cockpit state setup before the case starts
- `expected_calls`: expected tool calls; runners rewrite the expected
  `frontend` or `backend` path from the active domain routing
- `exact_arguments`: optional per-call flag for tools where extra arguments
  change behavior
- `expected_final_state`: dotted state assertions after execution
- `state_checkpoints`: optional dotted state assertions after specific turns
- `forbidden_calls_before_turn`: guardrail for chitchat turns
- `response_quality`: optional semantic rubric for later response-quality
  judging; it is reported separately and does not affect the main action score

## Scoring

`evaluator/score.mjs` scores a collected trace on:

- full case pass rate for tool/state behavior
- total expected and actual tool calls
- expected and actual tool calls by tool domain
- per-case-domain summaries for vehicle, music, navigation, and weather
- strict index-based tool, argument, path, and turn accuracy
- aligned tool, argument, path, and turn accuracy after same-tool sequence
  alignment
- alignment missing and extra call counts
- final state success
- state checkpoint success for long-context intermediate assertions
- no-spurious-tool rate before the actionable turn
- no-tool-on-silent-turn rate for turns marked `expect_no_tool`
- no-extra-tool-call rate
- response-quality judge coverage/rate when a separate judge has evaluated
  `response_quality` rubrics

`Tool acc` is strict index-based tool selection accuracy. It compares
`expected[i]` with `actual[i]`, so a missed or extra call can shift all later
comparisons.

`Aligned tool` first aligns same-name tool calls in order, then scores the
matched pairs. It is less sensitive to one missed or extra call and better
reflects whether the model chose the right tools somewhere in the sequence.

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

## Suites

By default, runners execute the short suite. Use `--suite long` for the mixed
long-context conversations or `--suite all` for both suites.

`--domain vehicle,music,navigation,weather` filters short-suite cases. Long
cases use `domain: "mixed"` and always expose the full vehicle, music,
navigation, and weather tool set.

## Runners

### Gold Replay

Gold replay deterministically replays expected calls against the benchmark
service to validate the dataset and scorer:

```bash
node examples/smart-cockpit/bench/runner/run-gold.mjs \
  --out examples/smart-cockpit/bench/reports/cockpit-gold-latest.json
```

### Text Model

The text runner uses the DashScope cockpit text model with the same cockpit
prompt, tool definitions, deterministic service, and case setup used by gold
replay:

```bash
node examples/smart-cockpit/bench/runner/run-text.mjs
```

Useful options:

```bash
node examples/smart-cockpit/bench/runner/run-text.mjs --limit 5
node examples/smart-cockpit/bench/runner/run-text.mjs --case-id nav_single_start_001
node examples/smart-cockpit/bench/runner/run-text.mjs --domain navigation
node examples/smart-cockpit/bench/runner/run-text.mjs --suite long
node examples/smart-cockpit/bench/runner/run-text.mjs --model qwen3.8-flash
```

Reports are written to `reports/cockpit-text-latest.json` by default.

### Realtime Model

The Realtime runner connects directly to the configured Realtime provider,
synthesizes each `turns.user` text with macOS `say`, streams 16 kHz PCM audio
to the model, executes Realtime function calls against the deterministic
benchmark service, and scores the resulting trace with the same evaluator as
text and gold.

It does not start the Gateway, A2A Agent, browser page, or production cockpit
service, so backend/page behavior changes do not move this score.

Useful options:

```bash
node examples/smart-cockpit/bench/runner/run-realtime.mjs --limit 3
node examples/smart-cockpit/bench/runner/run-realtime.mjs --case-id nav_single_start_001
node examples/smart-cockpit/bench/runner/run-realtime.mjs --domain navigation
node examples/smart-cockpit/bench/runner/run-realtime.mjs --suite long
node examples/smart-cockpit/bench/runner/run-realtime.mjs --realtime-model qwen-audio-3.0-realtime-flash
node examples/smart-cockpit/bench/runner/run-realtime.mjs --output text
node examples/smart-cockpit/bench/runner/run-realtime.mjs --say-voice Ting-Ting
```

Reports are written to `reports/cockpit-realtime-latest.json` by default and
include redacted provider events for debugging ASR/realtime failures.

### Full Realtime Voice Path

The full voice runner starts an in-process Cockpit Service, A2A Agent, and
Gateway. Each case resets the shared benchmark cockpit state, synthesizes the
`turns.user` text with macOS `say`, converts it to 16 kHz PCM with `ffmpeg`,
streams audio chunks to `/api/realtime`, records MCP calls from the
frontend/backend surfaces, and scores the trace with the same evaluator.

Use this as an end-to-end regression suite after the text/realtime score has
isolated the model-side capability.

Useful options:

```bash
node examples/smart-cockpit/bench/runner/run-voice.mjs --limit 3
node examples/smart-cockpit/bench/runner/run-voice.mjs --case-id nav_single_start_001
node examples/smart-cockpit/bench/runner/run-voice.mjs --realtime-model qwen-omni-turbo-realtime
node examples/smart-cockpit/bench/runner/run-voice.mjs --agent-model qwen3.8-flash
node examples/smart-cockpit/bench/runner/run-voice.mjs --say-voice Ting-Ting
```

Reports are written to `reports/navigation-voice-realtime-latest.json` by
default and include the raw Gateway voice events for debugging ASR/realtime
failures.
