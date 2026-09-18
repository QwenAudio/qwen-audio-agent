# Customer service harness tests

Tests cover the demo's approval lifecycle and an opt-in adapter for a trusted local
tau2-bench checkout. Keep A2A/MCP unchanged. No raw run logs or result JSON
are committed here.

The aggregate full-airline comparison is documented in
[AIRLINE_RESULTS.md](AIRLINE_RESULTS.md); it contains no raw run artifacts.

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

The runner executes three cases concurrently, one per group. `manifest.json`
records the source fingerprint, completed cases, errors and denominators. Restart
with the same configuration/output directory to continue pending cases; completed
cases are never rerun or selected by best reward. Interrupted cases without a
unique result count as infrastructure failures, not silent retries. Use a new
directory for a new experiment or changed code/configuration.

Scores use the official evaluator (including communication/assertion criteria,
not just DB equality) and verify live/replayed DB hashes. This is a text-only
adapted tau2 experiment: one trial per task, at most 16 user turns and 300 seconds
per case. Harness execution keeps its eight-model-round limit per execution;
native Max permits up to 100 model rounds per user turn within the case deadline.
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

Load accepts `domain` (retail/airline), optional string `taskId`, policy text and an
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
evaluation**. Cases have isolated temporary Gateway state. Limits: 16 user replies,
five minutes overall, eight backend model rounds per execution/resumption, and
90/120 seconds per frontend turn for baseline/harness. Preserve frontend tool budget.
Failures remain in the denominator; never silently select repeated trials.
Runtime receipts/prompts cannot guarantee models never misreport results.

Artifacts default to `.runtime/tau-harness`, or `CS_TAU_OUTPUT_DIR`; do not commit
them. The comparison helper accepts another root argument for a complete rerun,
instead of mixing selected trials.

Backend-only diagnostics remain available as
`npm run eval:customer-service:tau -- retail:0 airline:8`; these are not full harness
scores. `summarize.mjs` summarizes their per-domain batch directories.
