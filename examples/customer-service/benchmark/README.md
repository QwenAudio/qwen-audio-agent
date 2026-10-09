# Customer service harness tests

Tests cover the demo's approval lifecycle and an opt-in adapter for a trusted local
tau2-bench checkout. Keep A2A/MCP unchanged. No raw run logs or result JSON
are committed here.

The aggregate full-airline comparison is documented in
[AIRLINE_RESULTS.md](AIRLINE_RESULTS.md); it contains no raw run artifacts.
The adapted EVA Airline comparison is documented in
[EVA_AIRLINE_RESULTS.md](EVA_AIRLINE_RESULTS.md).

## Full three-way comparison

With the tau2 environment variables above and a configured DashScope key:

```sh
CS_TAU_OUTPUT_DIR=/path/to/local-results \
  node examples/customer-service/benchmark/run-full.mjs
```

This runs every base retail/airline task once in each of three modes:
`realtime-only`, `harness` (Realtime plus Max backend), and `max-only` (native
tau2 `LLMAgent`, without Realtime, A2A, or demo approval logic). Defaults use
`qwen3.8-max` for the tested Max agent/backend and the same `qwen3.8-flash` user
simulator and assertion judge across all groups. Override them with
`CS_TAU_BACKEND_MODEL`, `CS_TAU_USER_MODEL`, and `CS_TAU_JUDGE_MODEL` before starting.

The runner executes cases with bounded concurrency (one at a time by default).
`manifest.json` records the source fingerprint, completed cases, errors and denominators. Restart
with the same configuration/output directory to continue pending cases; completed
cases are never rerun or selected by best reward. Interrupted cases without a
unique result count as infrastructure failures. Use a new directory for a new
experiment or changed code/configuration.

The harness frontend now waits up to 180 seconds per turn by default
(`CS_TAU_HARNESS_TURN_TIMEOUT_SECONDS` overrides it); the overall case limit
remains 300 seconds. The full runner retries a timed-out case in any mode **once** by default
(`CS_TAU_TIMEOUT_RETRIES=0` disables this). It retries only a turn timeout,
an overall case timeout, or a worker killed by the outer timeout—not a normally
completed zero reward. Each attempt has a separate log/result file. The manifest's
`passed` and `successRate` remain first-attempt scores; `retryAdjustedPassed` and
`retryAdjustedSuccessRate` separately show recoveries after a timeout retry.
These adjusted numbers are operational diagnostics, not a replacement tau2 score.

For a harness-only refresh, set `CS_TAU_MODES=harness` and use a new output
directory. `CS_TAU_CONCURRENCY=3` runs up to three independent cases at once
(default 1; maximum 8). Keep concurrency modest to avoid provider rate limits;
the chosen modes and concurrency are recorded in the manifest and must not
change when resuming that directory.

Use `CS_TAU_DOMAINS` to run every task from one or more loaded domains without
manually expanding `CS_TAU_CASES`. The two selectors are mutually exclusive.

For a paired prompt check, set `CS_TAU_CASES` to the same comma-separated
`domain:taskId` list for two harness-only runs in separate output directories.
Set `CS_TAU_HARNESS_PROMPT_VARIANT=legacy` for the former generic-plus-policy
prompt and `compact` (the default) for the policy-first prompt. The manifest
records both the case selection and prompt variant. Each run has an independent
tau2 user simulator, so matching task IDs do not guarantee identical dialogue;
small score differences need trace inspection or repeated trials.

Scores use the official evaluator (including communication/assertion criteria,
not just DB equality) and verify live/replayed DB hashes. This is a text-only
adapted tau2 experiment: one trial per task, no fixed user-turn cap, and 300 seconds
per case. Harness execution keeps its eight-model-round limit per execution;
native Max permits up to 100 model rounds per user turn within the case deadline.
The harness frontend's initial system instructions use the full official domain
policy plus a short benchmark-specific tool/approval bridge. They do not load
the demo's generic voice-assistant prompt or `gateway/assistant/retail.md`;
the standalone example is unchanged. Realtime-only retains its own baseline
instructions. Tool descriptions and per-response input requests are separate
from these initial system instructions.
These are not the native benchmark's default step/trial settings or a voice test.
User-simulator drift can affect all groups; inspect failure traces rather than
attributing every zero reward to the tested agent. Full runs take hours and consume
paid agent, simulator and (where required) assertion-judge API calls.

## Quick regression tests (no model key)

Run from the repository root after installing the example dependencies:

```sh
npm run test:customer-service:smoke
npm run test:customer-service --ignore-scripts
```

Smoke tests use in-memory business state and model stubs; no DashScope or tau2-bench
is required. The full suite also tests services, clients and Gateway integration.

| Case | Expected result | Test file |
|---|---|---|
| Approve a saved preview | Commit the original operation once; hide its token from the model | `../agent/test/lifecycle.test.mjs` |
| Decline, cancel, expire or replay approval | No unauthorized or repeated write | `../agent/test/lifecycle.test.mjs` |
| Missing information | Suspend with `input_required`; restore the same task/messages | `../agent/test/lifecycle.test.mjs` |
| Information response contains yes | Still require a separate runtime write approval | `../agent/test/lifecycle.test.mjs` |
| No committed operation | Runtime receipt must not indicate a successful update | `../agent/test/lifecycle.test.mjs` |
| Progress heartbeat during approval | Allow the simulated user to answer | `test/realtime-harness.test.mjs` |
| New customer | Clear previous business/approval context | `../client/test/customer-reset.test.mjs` |

Framework regression tests also cover attempts to create new work while the same
session has a pending input or authorization request:

```sh
node --test server/test/tool-call-handler.test.mjs server/test/a2a-backend-adapter.test.mjs
```

## Optional official tau2 integration (no model key)

Use Python 3.12/3.13 and a trusted checkout. Install dependencies into a separate
virtual environment, not into the source checkout:

```sh
export CS_TAU2_ROOT=/path/to/tau2-bench
uv venv --python 3.12 /private/tmp/qwen-tau-runtime
uv pip install --python /private/tmp/qwen-tau-runtime/bin/python -r "$CS_TAU2_ROOT/pyproject.toml"
export CS_TAU2_PYTHON=/private/tmp/qwen-tau-runtime/bin/python
npm run test:customer-service:tau
```

Without both `CS_TAU2_*` variables, official Python tests explicitly skip. These
tests use reference-action model stubs, not accuracy measurements. Coverage includes
retail/airline tools, argument validation, session isolation, preview/commit, parameter
and DB-hash binding, shared identity, same-task input, denial/replay and trajectory replay.
When the tau2 checkout contains the optional `eva_airline` adapter, also set
`EVA_BENCH_ROOT=/path/to/EVA-bench-mix`; its integration test exercises a complete
EVA read/write gold trajectory through the same approval boundary and DB scorer.

## Policy/database injection API

The test API is disabled by default. Enabling it requires loopback binding and a
separate local token; never use the model API key as this token:

```sh
export CS_TEST_MODE=1 CS_TEST_TOKEN=replace-with-a-local-token
node examples/customer-service/service/server.mjs
```

In another shell, set the same `CS_TEST_TOKEN`, then load a sample:

```sh
curl -sS http://127.0.0.1:3110/api/test/scenarios/load \
  -H "Authorization: Bearer $CS_TEST_TOKEN" -H 'Content-Type: application/json' \
  -d '{"domain":"retail","taskId":"0"}'
```

Load accepts `domain` (retail/airline, plus `eva_airline` when that adapter is
installed), optional string `taskId`, policy text and an
official database JSON object. Defaults use original files; task initialization uses
original actions/message history. Preserve the official airline clock; arbitrary
clock overrides are rejected. Request bodies are limited to 16 MiB.

The response contains an isolated `sessionId`, version and task. Hidden task
instructions/reference actions are for the test controller only, never the tested
agent. Each case needs its own Agent/MCP session. Demo UI/tool configuration does not
automatically support official data. At most 20 sessions may be retained.

Use authenticated `GET /api/test/scenarios/snapshot?sessionId=...` to inspect state,
and `DELETE /api/test/scenarios?sessionId=...` to release it after stopping its Agent.
Released sessions cannot fall back to demo data.

Successful official identity tools establish session-bound identity for the backend
context API; objectives and DB fixtures do not. Identity is not authorization.
Writes preview in a copy, then require approval bound to session, operation,
parameters, version and original DB hash. Tokens are single-use, expire after five
minutes and never enter model context.

## Real-model text harness (requires model access)

Configure `DASHSCOPE_API_KEY` via the existing `.env.local` or environment, plus the
two `CS_TAU2_*` variables. Sample cases: `retail:0` (exchange), `airline:8` (booking).
These are small examples, not a representative full run.

```sh
CS_TAU_MODE=harness CS_TAU_BACKEND_MODEL=qwen3.8-max \
  CS_TAU_OUTPUT_DIR=/private/tmp/tau-comparison/harness \
  npm run eval:customer-service:harness -- retail:0 airline:8

CS_TAU_MODE=realtime-only CS_TAU_OUTPUT_DIR=/private/tmp/tau-comparison/realtime-only \
  npm run eval:customer-service:harness -- retail:0 airline:8

node examples/customer-service/benchmark/compare-harness.mjs /private/tmp/tau-comparison
```

The harness uses the real Realtime frontend, Gateway/TaskManager, read-only frontend
MCP, A2A backend and approval runtime. The frontend itself delegates and forwards
customer decisions; scripts do not approve or fill missing identity. Realtime-only
exposes original official tools without Gateway or extra runtime approval.
Frontend follows `QWEN_AUDIO_REALTIME_MODEL`. Harness backend defaults to Max only
in this runner; user/judge independently default to Flash and are configurable via
`CS_TAU_USER_MODEL`/`CS_TAU_JUDGE_MODEL`.

Both use the original UserSimulator/evaluator, complete policy and original tool/DB
semantics. Score follows the task reward basis (not always just DB); compare live and
replayed DB hashes. Hidden instructions go only to simulator/evaluator. Inspect
simulator drift when interpreting failures.

Input/output is text over real Realtime, **not ASR/TTS, physical audio or interruption
evaluation**. Cases have isolated temporary Gateway state. Limits: no fixed user-reply cap,
five minutes overall, eight backend model rounds per execution/resumption, and
90/180 seconds per frontend turn for baseline/harness by default. Preserve frontend tool budget.
Failures remain in the denominator; never silently select repeated trials.
Runtime receipts/prompts cannot guarantee models never misreport results.

### EVA content on the tau2 protocol

The optional tau2 `eva_airline` domain keeps EVA-Bench-mix as the source of truth
for its 50 airline tasks, per-task databases, policy and 15 function calls, while
using this runner's tau2 conversation and terminal-state evaluation form. This is
useful for a like-for-like Realtime/Max/harness comparison without modifying EVA's
source data:

```sh
export EVA_BENCH_ROOT=/path/to/EVA-bench-mix
CS_TAU_DOMAINS=eva_airline CS_TAU_MODES=harness CS_TAU_CONCURRENCY=8 \
  CS_TAU_OUTPUT_DIR=/private/tmp/eva-on-tau/harness \
  node examples/customer-service/benchmark/run-full.mjs
```

For a single smoke case, use `npm run eval:customer-service:harness --
eva_airline:eva_airline_1.1.2`. For a three-way full comparison, omit
`CS_TAU_MODES`; each of the 50 tasks then runs once in `realtime-only`, `harness`
and `max-only` mode.

This is an adapted EVA-on-tau experiment, not an official tau2 or EVA leaderboard
score. Gold actions are replayed to derive the terminal DB target, so equivalent
action paths can pass. Successful human transfers receive an adapter audit record;
privacy/refusal tasks use an unchanged-state target plus semantic policy assertions
instead of requiring incidental or contradictory reference calls. A customer's
explicit approval of a concrete proposal may be reused for every internal write
preview that the model verifies remains inside that proposal's scope.

Artifacts default to `.runtime/tau-harness`, or `CS_TAU_OUTPUT_DIR`; do not commit
them. The comparison helper accepts another root argument for a complete rerun,
instead of mixing selected trials.

Backend-only diagnostics remain available as
`npm run eval:customer-service:tau -- retail:0 airline:8`; these are not full harness
scores. `summarize.mjs` summarizes their per-domain batch directories.

## EVA Airline text harness

`eva-harness-bridge.mjs` is the JSON-lines adapter used by the separate
EVA-bench-mix checkout. It runs the same Realtime frontend, Gateway, A2A backend,
frontend/backend MCP split and approval runtime as the tau harness. EVA's Python
process remains the only owner of its policy tools and scenario database; the local
HTTP bridge previews writes on a copied database and commits only an exactly approved
operation against the same DB hash.

Run it from EVA-bench-mix so that the original EVA simulator and DB-based scorer stay
in control:

```sh
HARNESS_ROOT=/path/to/qwen-audio-agent \
  TARGET=harness RECORD_IDS=1.1.2 bash run_airline_text.sh
```

This path is text-in/text-out. It requires `DASHSCOPE_API_KEY` for both the Realtime
frontend and the configured backend model; simulator and judge credentials remain EVA
configuration. Runtime traces belong in EVA's output directory and are not source files.
