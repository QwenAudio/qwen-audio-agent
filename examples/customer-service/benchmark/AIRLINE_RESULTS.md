# Airline: full three-way evaluation

Run date: 2026-09-18. All 50 base airline tasks, one independent trial per task
per mode (150 trials total). This is an adapted **tau2-bench** experiment, not
the original tau-bench release or a native leaderboard run. Raw logs, dialogues,
result JSON and credentials remain local and are not included in this repository.

## Results

| Tested system | Passed / total | Success rate | Execution exceptions | Mean case duration |
|---|---:|---:|---:|---:|
| Realtime API only | 37 / 50 | 74.0% | 1 | 85.5 s |
| Harness: Realtime API + Max backend | 39 / 50 | 78.0% | 3 | 117.1 s |
| Max only: native tau2 LLMAgent | 38 / 50 | 76.0% | 2 | 112.9 s |

Exceptions are included in the denominator and have zero reward in this run.
No failed task was retried to replace its result. Mean duration includes local
environment startup, user simulation and grading; it is not agent-only latency.

Harness passed two more tasks than Realtime alone and one more than Max alone.
With only one trial per task, these small differences do not establish a stable
ranking or architectural advantage. Different tasks failed across the three modes.

## Models and scoring

- Realtime frontend: `qwen-audio-3.0-realtime-plus`.
- Harness backend / standalone agent: `qwen3.8-max`.
- Shared official user simulator and configured assertion judge: `qwen3.8-flash`.
- Inputs and outputs are text. ASR, TTS, audio latency and spoken interaction are
  not evaluated.
- Official `EvaluationType.ALL` supplies the reward. Airline reward criteria
  include DB and communication checks; DB equality alone is not the success rate.
- Live DB hashes matched the evaluator's replay in **150 / 150** cases. There
  were no scoring exceptions. Replay agreement verifies trajectory consistency,
  not correctness against the reference task.
- Each case allows 16 user turns and a 300-second deadline. Harness retains its
  eight-model-round limit per backend execution (resumed executions are separate).
  Native Max allows 100 model rounds per user turn within the deadline. These
  budgets differ from native benchmark defaults and between system architectures.
- Known user-simulator drift can affect measured outcomes. Remaining zero rewards
  should not be classified as model errors without examining their trajectories.

Standalone Realtime calls official tools directly. Harness uses the real Gateway,
TaskManager, MCP, A2A and runtime approval path. Standalone Max uses the official
`LLMAgent` with policy and original tools, without Realtime, A2A, approval
classification or hidden reference actions.

## Failed task IDs

| Mode | Failed IDs |
|---|---|
| Realtime only | 1, 7, 12, 14, 23, 25, 29, 32, 33, 35, 39, 42, 44 |
| Harness | 7, 10, 16, 18, 23, 29, 32, 33, 35, 39, 44 |
| Max only | 7, 10, 15, 18, 21, 25, 29, 32, 33, 35, 39, 42 |

Recorded execution exceptions:

| Mode | Task | Recorded error |
|---|---:|---|
| Realtime only | 44 | The operation was aborted |
| Harness | 10 | Realtime harness turn timed out |
| Harness | 23 | The operation was aborted |
| Harness | 39 | Realtime harness turn timed out |
| Max only | 10 | The operation was aborted due to timeout |
| Max only | 18 | The operation was aborted due to timeout |

These messages describe observed termination, not a diagnosed root cause. Retail's
response-concurrency errors are not airline results and are excluded from this table.

## Reproduction and provenance

See [the benchmark README](README.md#full-three-way-comparison) for the full runner.
To run only airline, pass all task IDs to `run-harness.mjs` separately under each
`CS_TAU_MODE`: `realtime-only`, `harness`, `max-only`. Use a new output directory
for a new experiment; do not merge trials or select the best reward.

- tau2 checkout commit: `79415270635376013d79a1051822a038e7116ba4`.
- Agent base commit at launch: `dcc916c31f24f55ecdf0649715c3f9ff847d77a7`,
  plus the three-way evaluation additions committed alongside this report.
- Launch source fingerprint:
  `5d41d3d6d182d4215872fed6becfb21a13e63446033777e5f763ecd62c9ba01a`.
- Added adapter/plan unit tests: 2 / 2 passed. The complete benchmark regression
  suite with local tau2 integration passed 21 / 21 before the full run started.

Retail was still running when this airline report was prepared. This commit does
not change model behavior or restart the ongoing experiment.
