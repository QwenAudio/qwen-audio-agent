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

### 前后端工具时延评测（真实音频输入）

本节仅汇报时延，与上文原有的功能正确性评测分开。使用真实 Gateway、realtime 模型和 A2A Agent，
通过语音输入比较同一套 short 用例走前端工具或后端工具的响应时间。

保留辅助脚本 `run-surface-compare.mjs` 和 `surface-latency-worker.mjs`，用于无语音的
进程内（`--mode direct`）、真实传输加 stub 模型（`--mode transport`）及模型跳数（`--mode model`）测量。
其 `cases/surface-compare.jsonl` 为 46 条单轮辅助用例，不与本次 86 条 short 实测混算。

#### 采集与统计口径

依赖：仓库根目录 `npm ci`、`npm run example:smart-cockpit:install`，以及 macOS `say` / `ffmpeg`。
凭据通过环境变量或 `examples/smart-cockpit/.env.local` 配置：`DASHSCOPE_API_KEY`；导航、天气另需 `AMAP_MCP_KEY`。

```bash
node examples/smart-cockpit/bench/runner/run-voice-surface-compare.mjs \
  --suite short --service-mode example --silence-ms 2200 --timeout-ms 120000 --settle-ms 1200
```

- 语音由 `say`（`Tingting`）合成，转换为 16 kHz 单声道 s16le PCM，按 20 ms 分片推给 `/api/realtime`。
- 原样使用 `cases/vehicle.jsonl`、`music.jsonl`、`navigation.jsonl`、`weather.jsonl`：86 条、111 轮。
  保留 setup、原话术和多轮上下文。每条 case 新会话，首轮冷启保留，不做额外预热；不运行 long。
- 前端模型直接调用座舱工具；后端模型经 `spawn_thinking` → A2A Agent → MCP 执行。
  两种路由各自独立进程、串行测量，不争抢同一模型配额。
- `example` 使用真实高德 MCP（地点/天气）及 REST（驾车路线），车控/音乐为 example 本地实现；
  需要高德的领域先做真实 MCP 预检，不回退模拟数据。`controlled` 仅作显式模拟对照，不能与本次数据混算。
- 两项零点都是本轮语音 PCM 推送结束（静音尾巴之前）。执行前为本轮最晚工具开始；执行后为
  全部已调用工具结束后的最晚返回/抛错。不包含工具返回后的 MCP 传输、音频结束或后台任务终态。
  车控/音乐是 handler 返回时间，不是实车动作或歌曲播放完成时间。
- 每轮独立统计；多工具取最晚开始及最晚结束，不累加，两终点可能来自不同并发工具。
  每端对自身全部有时间戳的任务轮取算术平均，保留失败返回、误调用及长尾，不筛选正确性。
  缺失不填零；未结束不填结束时间。两端有效样本集合可能不同，表中分别列出数量。
- 92 个任务轮进入均值；14 轮闲聊和 5 轮澄清/拒绝保留在数据中，但不进入任务时延统计。
- `timing_schema: 2` 在 bench 实例的 `service.execute` 前后计时，不修改业务 handler。
  旧 `completed_ms` 仅为执行入口，不能当作完成指标，也不能混入本次数据。
- 采集时等待每轮收尾再推下一轮，等待不计入两项工具时延；异常后仍有异步任务则停止后续采样，防止串轮。
  过程诊断和检查点留在本地被忽略的 `reports/voice-surface-*`，发布时使用下方纯计时导出。

可用 `--domain vehicle,music` / `--domain navigation,weather` 分批采集，再离线合并：

```bash
node examples/smart-cockpit/bench/runner/run-voice-surface-compare.mjs \
  --from-reports <车控音乐报告.json>,<导航天气报告.json> --out <新的四领域报告.json>
```

合并要求模型、计时、业务模式及参数一致且 case 不重复，按原始响应重算总均值，不平均批次均值。
本次没有补测；若使用 `--retry-errors-from`，仅重试连接/观测错误，保留原尝试并标记来源。

#### 当前实测：四领域双指标汇总（2026-09-11）

模型：`qwen-audio-3.0-realtime-plus` / `qwen3.8-flash`。
车控/音乐与导航/天气分两批实测，配置相同，非同一次连续运行；合计每端 86 条、111 轮，含 92 个任务轮。
本次整理保留已有实测时间戳，只离线重算；脚本已适配最新主线，但没有对 rebase 后的工具定义重新实测。
以下单位均为毫秒，起点均为每轮语音 PCM 推送结束。

##### 执行前

| 领域 | 任务轮数 | 前端均值/ms | 后端均值/ms | 差值（后−前）/ms | 前端有效数 | 后端有效数 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 车控 | 23 | 1539.0 | 3276.6 | 1737.6 | 23 | 22 |
| 音乐 | 17 | 1153.3 | 2505.8 | 1352.5 | 17 | 15 |
| 导航 | 44 | 1302.9 | 3859.5 | 2556.6 | 44 | 30 |
| 天气 | 8 | 1034.5 | 3209.0 | 2174.5 | 6 | 1 |
| 合计 | 92 | 1317.1 | 3362.7 | 2045.6 | 90 | 68 |

##### 执行后

| 领域 | 任务轮数 | 前端均值/ms | 后端均值/ms | 差值（后−前）/ms | 前端有效数 | 后端有效数 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 车控 | 23 | 1539.3 | 3276.8 | 1737.5 | 23 | 22 |
| 音乐 | 17 | 1153.6 | 2506.1 | 1352.5 | 17 | 15 |
| 导航 | 44 | 1615.7 | 4300.9 | 2685.2 | 44 | 30 |
| 天气 | 8 | 1187.0 | 3361.0 | 2174.0 | 6 | 1 |
| 合计 | 92 | 1480.3 | 3559.9 | 2079.6 | 90 | 68 |

天气后端只有 1 个有效响应，不宜据此推断稳定性能；两端均值并非同一配对样本集合。
导航包含本地设置，不是每轮都联网。真实业务等待计入执行后；长尾及失败返回不剔除。

- [评测结果（两张时间表）](results/voice-surface-short-20260911.json.md)
- [HTML 结果](results/voice-surface-short-20260911.json.html)
- [执行前逐轮 CSV](results/voice-surface-short-20260911.json.before.csv)
- [执行后逐轮 CSV](results/voice-surface-short-20260911.json.after.csv)
- [可重算的评测数据 JSON](results/voice-surface-short-20260911.json)

#### 离线复现发布结果

提交的计时数据保留 86 条用例、每端 111 轮的逐调用 `started_ms`、`ended_ms`、`duration_ms`，
以及模型、音频、时间参数、路由和分批来源；不含过程事件、转写、工具返回、评分或本机绝对路径。
原始诊断文件仅留在本地 `reports/`，不作为 PR 附件。

安装根目录及 example 的依赖后，从仓库根目录执行（不需要凭据，不调用外部服务）：

```bash
node examples/smart-cockpit/bench/runner/run-voice-surface-compare.mjs \
  --from-report examples/smart-cockpit/bench/results/voice-surface-short-20260911.json \
  --timing-only --out examples/smart-cockpit/bench/reports/voice-surface-reproduced.json
```

输出新的计时 JSON，以及执行前、执行后各自的汇总 CSV 和逐轮 CSV、两张汇总表的 Markdown/HTML。
输出路径必须未占用，不覆盖来源。`--timing-only` 仅支持 short 双时间戳数据；旧埋点不能补算执行后。
发布数据支持再次离线导出，时延及样本数保持一致；不需要过程日志。
