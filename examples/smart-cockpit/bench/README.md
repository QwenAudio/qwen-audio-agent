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
| Vehicle | 24 | 23 | 100.00% | 23 | 100.00% | 23 |
| Music | 18 | 17 | 100.00% | 17 | 100.00% | 17 |
| Navigation | 36 | 44 | 100.00% | 44 | 97.22% | 44 |
| Weather | 8 | 8 | 100.00% | 8 | 100.00% | 8 |
| Overall | 86 | 92 | 100.00% | 92 | 98.84% | 92 |

Gold replay passes all 86 cases with 92 expected and 92 actual tool calls,
confirming the dataset, deterministic service, and scorer are internally
consistent.

The text run has no remaining short-suite failures. The single Realtime failure
is `nav_chitchat_memory_then_favorite_031`, where ASR transcribed
`阿里西溪园区` as `阿里西西园区`, so the tool was selected correctly but the
address argument was wrong. This is a speech-recognition artifact, not a tool
selection or dataset problem.

### Long-Context Suite

The long-context suite contains 10 mixed-domain conversations, 500 total
conversation turns, 250 expected tool calls, and 250 no-tool chitchat or
background turns. Because every case is mixed-domain, the table only shows core
overall metrics.

| Model | Calls exp/act | Tool acc | Aligned tool | Arg acc | Aligned arg | Missing/extra | Final state | Checkpoints | Silent turns |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Text `qwen3.8-flash` | 250 / 252 | 88.80% | 100.00% | 91.20% | 100.00% | 0 / 2 | 100.00% | 100.00% | 90.00% |
| Realtime `qwen-audio-3.0-realtime-plus` | 250 / 246 | 71.20% | 98.40% | 76.00% | 98.40% | 4 / 0 | 100.00% | 80.00% | 100.00% |

Gold replay passes the long suite with 10/10 cases and 250/250 tool calls. The
combined `--suite all` gold replay passes 96/96 cases with 342/342 tool calls.

All 10 Realtime cases now complete the full 50-turn script. Turn-timeout retry
recovered `mixed_long_morning_commute_001` after a silent timeout at turn 40,
and no case ended in `confirmed_failure_at_turn` or
`unstable_infrastructure`.

Every one of the 4 remaining Realtime missing calls is the same test point:
`navigation_add_waypoint` at turn 15 in 4 of the 10 cases. The model asks which
destination to use instead of adding the waypoint, even though turn 9 already
started navigation and the service still reports the destination. Text runs
with full history execute this call 10/10. The gap is context retention across
about 14-18 conversation items, not tool definition or model capability, so it
should be read as a memory-system signal rather than a dataset defect.

The two remaining text failures are genuine model errors: one spurious
`vehicle_comfort_control` on a chitchat turn, and one duplicated
`music_volume_control`.

Because earlier Realtime runs aborted whole cases on the first turn timeout,
their scores are not directly comparable to these numbers. Aborted runs never
reached the later checkpoints, while the current long-context numbers are based
on complete 50-turn transcripts and should be read through call-level,
state-checkpoint, and silent-turn metrics instead of a task-completion rate.

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

## Realtime Timeout Retry

`Timed out waiting for realtime turn.` has several possible causes: audio
streaming problems, provider connection silence, or generation stalls. The
Realtime runner separates infrastructure flakiness from real defects instead of
letting one timeout abort the rest of a case.

| Level | Flag | Default | Behavior |
| --- | --- | ---: | --- |
| Turn retry | `--turn-retries` | 1 | Re-streams the same utterance audio on a timeout |
| Case restart | `--case-attempts` | 2 | Reruns the whole case with a fresh connection and fresh state |

A turn is only retried when the timed-out turn produced **no** tool call and
**no** assistant text. Re-streaming audio after the model already acted would
duplicate the tool call and corrupt the trace, so a timeout that follows real
output is treated as a generation stall and escalated straight to a case
restart.

When every attempt fails, the runner classifies the case:

- `confirmed_failure_at_turn`: all attempts failed at the same turn index. The
  test point is reproducibly broken and worth investigating.
- `unstable_infrastructure`: attempts failed at different turn indexes, which
  points at connection flakiness rather than a specific test point.
- `recovered`: a later attempt succeeded.

Scoring uses the attempt that completed the most turns, and the chosen attempt
is recorded in each trace as `selected_attempt` so the choice stays auditable.
Report-level `retry_summary` aggregates turn retries, case retries, recovered
cases, confirmed failures, unstable cases, and `ignored_calls`. Set
`--turn-retries 0 --case-attempts 1` to reproduce the old fail-fast behavior.

`ignored_calls` counts function calls that arrived outside a turn boundary and
were therefore dropped. They used to be silently discarded, which inflated the
missing-call count and made the cause invisible.

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

- optional full-case pass rate for short-suite sanity checks
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

Before comparing arguments, the scorer normalizes documented equivalences so a
correct call is not marked wrong on formatting alone:

- `vehicle_closure_control`: `trunk` and `rear_trunk` are the same target, as
  are `fuel_port` and `charge_port`
- `vehicle_comfort_control`: the retired `steering_wheel_heat_level` target maps
  to `steering_wheel_heater`
- `vehicle_window_control`: an omitted `window` becomes `windows`, matching the
  service default of acting on every window

The last rule still rejects a call that names one specific window, so it relaxes
formatting without weakening the check.

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

### Frontend/backend tool latency (real audio input)

This section reports latency only and stays separate from the correctness
benchmarks above. It drives the real Gateway, realtime model and A2A Agent, then
compares how long the same short cases take when their tools run on the frontend
surface versus the backend surface.

`run-surface-compare.mjs` and `surface-latency-worker.mjs` remain available for
voiceless measurements: in-process (`--mode direct`), real transport with a stub
model (`--mode transport`) and model hops (`--mode model`). Their
`cases/surface-compare.jsonl` holds 46 single-turn helper cases and is never
mixed into the 86 short cases measured here.

#### Measurement and statistics

Prerequisites: `npm ci` and `npm run example:smart-cockpit:install` in the
repository root, plus macOS `say` and `ffmpeg`. Credentials come from the
environment or `examples/smart-cockpit/.env.local`: `DASHSCOPE_API_KEY`, and
`AMAP_MCP_KEY` for navigation and weather.

```bash
node examples/smart-cockpit/bench/runner/run-voice-surface-compare.mjs \
  --suite short --service-mode example --silence-ms 2200 --timeout-ms 120000 --settle-ms 1200
```

- Speech is synthesized with `say` (`Tingting`), converted to 16 kHz mono s16le
  PCM and streamed to `/api/realtime` in 20 ms chunks.
- `cases/vehicle.jsonl`, `music.jsonl`, `navigation.jsonl` and `weather.jsonl`
  are used unchanged: 86 cases, 111 turns, with their setup calls, original
  utterances and multi-turn context. Every case opens a new session and keeps its
  cold first turn; there is no extra warmup and the long suite is not run.
- On the frontend surface the realtime model calls cockpit tools directly; on the
  backend surface it delegates through `spawn_thinking` → A2A Agent → MCP. Each
  routing runs in its own process, measured serially so the two never compete for
  the same model quota.
- `example` uses the real Amap MCP (places, weather) and REST (driving routes),
  while vehicle and music keep the example's local handlers. Domains that need
  Amap are preflighted against the live MCP instead of falling back to simulated
  data. `controlled` is an explicit simulation baseline and must not be mixed
  into these numbers.
- Both metrics share one zero point: the moment this turn's speech PCM finishes
  streaming, before the trailing silence. *Before* is the latest tool start in
  the turn; *after* is the latest resolve/reject once every tool already invoked
  has finished. Neither includes the MCP response transport, the reply audio or
  backend task terminal states. For vehicle and music these are handler return
  times, not real vehicle actuation or playback completion.
- Every turn is counted independently. With several tools in one turn the latest
  start and the latest end are taken rather than summed, so the two endpoints may
  belong to different concurrent tools. Each surface averages all of its own
  timestamped task turns — failed returns, wrong tools and long tails included —
  without filtering on correctness. Missing values are never treated as zero and
  an unfinished tool yields no *after* value. The two surfaces may end up with
  different valid samples, so both counts are listed.
- 92 task turns feed the means. 14 chitchat turns and 5 clarification/refusal
  turns stay in the data but never enter the task latency statistics.
- `timing_schema: 2` wraps `service.execute` on the bench instance; business
  handlers are untouched. The legacy `completed_ms` marks only the execution
  entry, so it is not a completion metric and cannot be mixed in here.
- Collection waits for each turn to settle before the next one, and that wait is
  excluded from both metrics. If an observation error leaves async work pending,
  sampling stops instead of bleeding into later turns. Process diagnostics and
  checkpoints stay in the ignored `reports/voice-surface-*`; publication uses the
  timing-only export below.

Domains can be measured in batches with `--domain vehicle,music` and
`--domain navigation,weather`, then merged offline:

```bash
node examples/smart-cockpit/bench/runner/run-voice-surface-compare.mjs \
  --from-reports <vehicle-music-report.json>,<navigation-weather-report.json> --out <merged-report.json>
```

Merging requires identical models, timing schema, service mode and parameters
with no duplicate cases, and recomputes the overall means from the raw responses
instead of averaging batch means. No recovery run was needed here; with
`--retry-errors-from` only connection/observation errors are retried, and the
original attempt is kept and marked with its source.

#### Measured results: four domains, two metrics

Models: `qwen-audio-3.0-realtime-plus` and `qwen3.8-flash`. Vehicle/music and
navigation/weather were measured in two batches with identical configuration
rather than one continuous run: 86 cases and 111 turns per surface, including 92
task turns. These numbers are the recorded measurements recomputed offline; the
scripts were realigned with the current main, but the tool definitions after that
rebase were not measured again. All values are milliseconds from the end of each
turn's speech PCM.

##### Before execution

| Domain | Task turns | Frontend mean/ms | Backend mean/ms | Difference (backend − frontend)/ms | Frontend valid | Backend valid |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| vehicle | 23 | 1539.0 | 3276.6 | 1737.6 | 23 | 22 |
| music | 17 | 1153.3 | 2505.8 | 1352.5 | 17 | 15 |
| navigation | 44 | 1302.9 | 3859.5 | 2556.6 | 44 | 30 |
| weather | 8 | 1034.5 | 3209.0 | 2174.5 | 6 | 1 |
| all | 92 | 1317.1 | 3362.7 | 2045.6 | 90 | 68 |

##### After execution

| Domain | Task turns | Frontend mean/ms | Backend mean/ms | Difference (backend − frontend)/ms | Frontend valid | Backend valid |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| vehicle | 23 | 1539.3 | 3276.8 | 1737.5 | 23 | 22 |
| music | 17 | 1153.6 | 2506.1 | 1352.5 | 17 | 15 |
| navigation | 44 | 1615.7 | 4300.9 | 2685.2 | 44 | 30 |
| weather | 8 | 1187.0 | 3361.0 | 2174.0 | 6 | 1 |
| all | 92 | 1480.3 | 3559.9 | 2079.6 | 90 | 68 |

The backend weather mean rests on a single valid response and says nothing about
stable performance; the two surfaces are not averaged over the same paired
samples. Navigation includes local settings, so not every turn hits the network.
Real business waits land in the *after* metric, and long tails and failed returns
are not trimmed.

- [Results, two timing tables](results/voice-surface-short-20260911.json.md)
- [HTML results](results/voice-surface-short-20260911.json.html)
- [Per-turn CSV, before execution](results/voice-surface-short-20260911.json.before.csv)
- [Per-turn CSV, after execution](results/voice-surface-short-20260911.json.after.csv)
- [Recomputable timing data](results/voice-surface-short-20260911.json)

#### Reproducing the published results offline

The committed timing data keeps `started_ms`, `ended_ms` and `duration_ms` for
every call across 86 cases and 111 turns per surface, together with the models,
audio settings, timing parameters, routing and batch sources. It carries no
process events, transcripts, tool payloads, scores or local absolute paths. The
raw diagnostics stay in the local `reports/` and are not part of this change.

With the root and example dependencies installed, run this from the repository
root; it needs no credentials and calls no external service:

```bash
node examples/smart-cockpit/bench/runner/run-voice-surface-compare.mjs \
  --from-report examples/smart-cockpit/bench/results/voice-surface-short-20260911.json \
  --timing-only --out examples/smart-cockpit/bench/reports/voice-surface-reproduced.json
```

It writes a fresh timing JSON plus, for each phase, a summary CSV, a per-turn CSV
and the two summary tables as Markdown and HTML. The output path must be unused;
the source is never overwritten. `--timing-only` accepts short dual-timestamp
data only — the legacy instrumentation cannot reconstruct an *after* value.
Published data can be exported again with identical latencies and sample counts,
without any process log.
