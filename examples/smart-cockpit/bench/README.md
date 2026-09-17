# Smart Cockpit Benchmark

This guide separates **tool correctness**, **tool-placement latency**, and
**software regression tests**. They measure different things; a simulated test
passing is not a live voice or physical-vehicle result.

- [Accuracy results and provenance](results/accuracy.md)
- [Recorded tool-return latency](results/voice-surface-short-20260911.json.md)
- [Historical accuracy snapshots](results/accuracy-history.md)
- [Software test matrix](../docs/test-matrix.md)

## Terminology

| Term | Meaning |
|---|---|
| Test case / 测试用例 | A scripted scenario with initial state, user inputs, expected calls, and optional state assertions. |
| Dialogue turn / 交互轮 | One user input and its processing. Tool outputs and follow-up model responses do not create extra user turns. |
| Test turns requiring tools / 测试轮数（需工具） | The number of user turns whose gold answer requires tools. Not task-completion steps, case count, or valid timing sample count. |
| Expected tool calls / 预期工具调用次数 | Calls required by the gold answer. A multi-intent turn can require several calls; the current short/long accuracy datasets expect at most one per turn. |
| Tool coverage / 工具覆盖数 | Distinct tool names in the expected calls, not the number of tools offered to the model. |
| Valid timing samples / 有效计时样本数 | Turns with the timestamps needed for the selected latency metric, counted separately for each route. |

A 50-turn case is one continuous conversation, not 50 independent sessions.
Each new case resets the scenario/session. User turns are not API request counts:
tool-result continuations can require additional model requests.

## Dataset

Both suites use the vehicle, music, navigation, and weather tool catalog.
The long suite has separately designed mixed-domain cases covering 22 of the
34 tools exercised by short cases. It is not the short questions replayed with
only the history length changed.

| Suite | Cases | Turns per case | Total turns | Turns requiring tools | No-tool turns | Expected calls | Tools covered |
|---|---:|---:|---:|---:|---:|---:|---:|
| Short | 86 | 1–3 | 111 | 92 | 19 | 92 | 34 |
| Long | 10 | 50 | 500 | 250 | 250 | 250 | 22 |

Short cases comprise 62 single-turn, 23 two-turn, and one three-turn case.
Their 19 no-tool turns comprise 14 chitchat and 5 clarification/refusal controls.

| Short domain | Case file | Cases | Expected calls |
|---|---|---:|---:|
| Vehicle | [vehicle.jsonl](cases/vehicle.jsonl) | 24 | 23 |
| Music | [music.jsonl](cases/music.jsonl) | 18 | 17 |
| Navigation | [navigation.jsonl](cases/navigation.jsonl) | 36 | 44 |
| Weather | [weather.jsonl](cases/weather.jsonl) | 8 | 8 |

Long cases live in [mixed-long-context.jsonl](cases/mixed-long-context.jsonl).
Flash-buy, custom skills, memory personalization, and long-running background
research are not correctness targets in these two suites; see the
[demo checklist](../docs/demo-recording.zh.md).

### Coverage limits

The current long cases alternate no-tool and tool turns at fixed positions.
Across 500 turns there are 154 distinct user utterances (128 actionable, 26
no-tool); each actionable turn expects one call. This is a controlled
continuous-dialogue regression set, not a broad multi-intent or adversarial
long-context benchmark.

The aggregate includes early and late turns, not just performance at turn 50.
Turn count also does not specify a token context length. To study degradation,
use matched questions/state with controlled history lengths and report late-turn
results, context tokens, repeated runs, and errors—not only one overall score.

Case fields include `turns`, `expect_no_tool`, `setup_calls`,
`expected_calls[].turn_index`, `expected_final_state`, and optional
`state_checkpoints`, `forbidden_calls_before_turn`, and `response_quality`.
Arguments use expected-field matching unless `exact_arguments` is set.
See [case validation](evaluator/cases.mjs).

## Evaluated paths

| Subject | Runner | Input and execution |
|---|---|---|
| Text model | [run-text.mjs](runner/run-text.mjs) | Canonical text, controlled prompt/tools, deterministic service. |
| Realtime-plus | [run-realtime.mjs](runner/run-realtime.mjs) | Synthesized voice to `qwen-audio-3.0-realtime-plus`, controlled prompt/tools, deterministic service, no Gateway. |
| Realtime-plus + Harness | [run-voice.mjs](runner/run-voice.mjs) | Voice through Gateway + A2A Agent + Service; production frontend composition and active routing. |

Text and controlled Realtime use the same benchmark prompt and business tools.
Harness uses the framework prompt/persona, dynamically described MCP tools,
runtime guards, and structured tool results; it is a **system evaluation**, not
an identical-prompt model ablation. Both voice paths synthesize user speech with
macOS `say` and convert it to 16 kHz PCM with `ffmpeg`.

The Harness trace records service-side MCP calls after Gateway guards;
`custom_skill_list` is excluded from the scored trace. Controlled Realtime
records direct calls and returns text content, whereas the Harness MCP path also
returns structured state. Do not attribute a score difference solely to a
prompt, session management, memory, or the backend model without an ablation.

The committed domain routing puts these four business domains on the frontend.
`--agent-model` does not mean every Harness test is solved by that backend.
Routing is controlled by [surface-routing.json](../service/tools/surface-routing.json),
`COCKPIT_TOOL_SURFACE_ROUTING`, or `COCKPIT_DOMAIN_SURFACES`; reports retain the
routing snapshot. Clear unintended overrides before a comparison.

## Scoring

Use explicit metric names; do not label all of the following “tool accuracy”.

| Metric | Unit and success condition |
|---|---|
| Full-case pass / 整例通过率 | All calls, parameters, route labels, turn positions, no-tool constraints, final state and specified checkpoints pass for the case. One error fails that case. |
| Per-turn tool behavior / 逐轮工具行为准确率 | Within the same user turn, required calls and parameters match with no missing/extra calls; a no-tool turn makes zero calls. Excludes response quality and cross-turn state assertions. |
| Strict sequence tool/argument accuracy | Compare `expected[i]` with `actual[i]` across the whole case. Missing/extra calls can shift later indexes. |
| Aligned tool/argument accuracy | Align same-name calls in sequence across the case; divide correct matches by expected calls. May match across turns, and must be accompanied by missing/extra counts. |
| Final-state / checkpoint success | State assertions, separate from tool behavior. |
| No-tool case pass (legacy `Silent turns`) | Cases with no calls on any marked no-tool turn / all cases. Not per-turn no-tool correctness. |

For the long per-turn result, publish all three:
**overall = passed / 500**, **tool-required = passed / 250**,
**no-tool = passed / 250**. Counts must be from the same run.

The existing [score.mjs](evaluator/score.mjs) and runner `summary` still emit
full-case and sequence metrics. The per-turn results page is an **offline
reaggregation**, not a renamed `pass_rate`, `tool_selection_accuracy`, or
`aligned_tool_selection_accuracy` field. Raw per-turn traces are required to
reproduce it; aggregate legacy percentages are insufficient.

For offline reaggregation, group expected and actual calls by `turn_index`,
check each turn independently with the original path/name/argument rules,
and omit state/response checks from this specific metric. Validate that every
expected turn completed; do not silently drop missing or aborted turns.

Argument normalization is implemented in the scorer: closure-target aliases,
the retired steering-wheel heat target, omitted all-window selection, and
place-search category/query and 餐厅/restaurant equivalents. Matching is not an
LLM semantic judgment. Legacy argument accuracy tests parameters separately
from tool-name accuracy. Extra arguments are permitted unless
`exact_arguments` is set. Response-quality rubrics are separate and require
an explicit judge; the default action score is not spoken-answer quality.

## Run accuracy tests

From the repository root, install dependencies with `npm ci` and
`npm run example:smart-cockpit:install`. Gold replay needs no model credentials:

```bash
node examples/smart-cockpit/bench/runner/run-gold.mjs --suite all
```

Live model tests consume API usage. Configure `DASHSCOPE_API_KEY` in the
environment or the example's `.env.local`; voice runners also need macOS
`say` and `ffmpeg`. Always select a **new output path** to retain prior runs:

```bash
node examples/smart-cockpit/bench/runner/run-text.mjs --suite long --model qwen3.8-flash --out examples/smart-cockpit/bench/reports/text-long-run-001.json
node examples/smart-cockpit/bench/runner/run-realtime.mjs --suite long --realtime-model qwen-audio-3.0-realtime-plus --out examples/smart-cockpit/bench/reports/realtime-long-run-001.json
node examples/smart-cockpit/bench/runner/run-voice.mjs --suite long --realtime-model qwen-audio-3.0-realtime-plus --agent-model qwen3.8-flash --out examples/smart-cockpit/bench/reports/harness-long-run-001.json
```

Default suite: `short`; `--suite all` combines both.
`--limit` and `--case-id` select cases. `--domain` filters short cases;
long cases are mixed-domain and retain all four business tool domains.
Text defaults to thinking enabled; record the actual run setting and model
alias rather than treating an alias as a pinned model snapshot.

### Timeout and retry policy

Both accuracy voice runners default to `--turn-retries 1 --case-attempts 2`:
one retry after a turn timeout with **no tool call and no assistant text**,
and at most two total case attempts. Output followed by a stall causes a case
restart, not a repeated user request within that attempt.

The most-complete attempt is selected, not the highest-scoring attempt.
Reports retain `selected_attempt`, retry counts, completion/failure positions,
and ignored calls. `--turn-retries 0 --case-attempts 1` disables recovery.
An attempt completing 50 turns is not necessarily a fully correct case.
Keep failed/aborted attempts and distinguish infrastructure errors from scored
behavior; do not describe every timeout as a model reasoning failure.

## Tool-placement latency

This comparison keeps the Realtime frontend in **both** paths. It measures the
same business tools called directly by the frontend or delegated through
`spawn_thinking → A2A Agent → MCP`. It is not Realtime versus a text-only
system, nor a test of long-running task completion.

- **Start point:** end of the user utterance's streamed PCM, before trailing silence.
- **Before execution:** time to the last service tool start in the turn.
- **After execution / tool-return latency:** time to the last resolve/reject of
  all invoked tools. Use this when a single return-latency table is needed.
- Neither endpoint includes subsequent MCP response delivery, reply audio, or
  real vehicle action. Multiple tool times are not summed.
- “Test turns (tool-required)” counts planned inputs, not valid measurements.
  Each route averages its own timestamped samples, including failed returns,
  wrong tools and long tails; missing timestamps are not zero.

The [2026-09-11 report](results/voice-surface-short-20260911.json.md) uses
Realtime-plus + `qwen3.8-flash`, with 92 tool-required turns but **90 frontend /
68 backend valid return timings**. Backend weather has only one valid sample.
Keep valid counts with latency tables: the two means are not paired-sample
estimates. The report is an offline merge of two recorded batches, not a rerun
of today's tool definitions.

### Live collection and offline reproduction

`--service-mode example` uses real AMap for navigation/weather and the example
handlers for vehicle/music; those local handlers do not control a physical car.
`--service-mode controlled` is a simulation baseline and must remain separate.

```bash
node examples/smart-cockpit/bench/runner/run-voice-surface-compare.mjs --suite short --service-mode example --silence-ms 2200 --timeout-ms 120000 --settle-ms 1200 --out examples/smart-cockpit/bench/reports/latency-run-001.json
```

Live collection needs model credentials plus `AMAP_MCP_KEY` for map domains.
Split with `--domain vehicle,music` / `--domain navigation,weather` if needed;
`--from-reports path1,path2` merges compatible batches without duplicate cases.
Recovery via `--retry-errors-from` applies to observation/connection errors,
not ordinary score failures.

Re-export the committed timing data **without model/API calls**:

```bash
node examples/smart-cockpit/bench/runner/run-voice-surface-compare.mjs --from-report examples/smart-cockpit/bench/results/voice-surface-short-20260911.json --timing-only --out examples/smart-cockpit/bench/reports/latency-offline-001.json
```

This produces timing JSON, Markdown, HTML and CSV. The output must be unused;
the source is not overwritten. The 46 helper cases in
`cases/surface-compare.jsonl` belong to the separate voiceless
`run-surface-compare.mjs` direct/transport/model checks, not these 86 short cases.

## Result maintenance

Maintain canonical accuracy tables in [results/accuracy.md](results/accuracy.md).
The English and Chinese example READMEs retain core short full-case, long
per-turn, and tool-return latency tables. Documentation tests compare every
headline row with the canonical accuracy page or generated timing report;
update these summaries together, without promoting legacy diagnostics to the
headline metric. Domain breakdowns and run details stay in the results pages.
For each update retain the date, code/dataset revision, input path, model alias,
thinking/retry settings, routing, scoring unit, numerator/denominator, and raw
trace availability. Mark team-supplied summaries separately from locally
recomputed traces. Do not merge submetrics from different runs.

Keep historical results as dated records rather than deleting less favorable
runs. Changes to scoring or prompts are not ordinary reruns. Repeated runs are
needed for stable comparisons; this documentation refresh does not rerun models.
Timing tables are generated by the runner, not edited independently of it.
