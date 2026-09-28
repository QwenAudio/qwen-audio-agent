# EVA Airline: adapted three-way evaluation

This report records a text-only comparison over the 50 public Airline records
from EVA-Bench-mix, adapted to the tau2 conversation and terminal-state scoring
protocol. It is not an official EVA or tau2 leaderboard result. Raw dialogues,
API keys and generated run artifacts are intentionally not committed.

## Results

| Tested path | Completed-trial passes | Task completion |
|---|---:|---:|
| Realtime API only | 22 / 50 | 44% |
| Realtime API + customer-service Harness + Qwen3.8-Max backend | 31 / 50 | 62% |
| Qwen3.8-Max only | 34 / 50 | 68% |

The simulator and assertion judge were GPT-5.6-Luna for all three paths. Each
task used an isolated database, the complete EVA Airline policy and original EVA
function schemas. Input and output were text; ASR, TTS and physical audio were
not evaluated.

“Completed-trial” keeps all 50 tasks in the denominator. An attempt that ended
before a scoreable trajectory because of a provider, transport or worker timeout
was rerun; the first normally completed pass or failure was retained. Normally
completed zero-reward tasks were never rerun. For operational reliability, keep
the manifest's first-attempt and retry-adjusted fields alongside this
infrastructure-completed comparison.

The Realtime-only result is the second full run (the first completed-trial run
was 21 / 50, or 42%). Harness full runs before the latest generic routing changes
scored 25 / 50 and 24 / 50; the recorded post-change run scored 31 / 50. Because
each run has an independent model-driven simulator dialogue, this difference is
evidence of improvement, not a deterministic attribution. Inspect task-level
flips and repeat trials before treating the full delta as a prompt effect.

## Reproduction

Use trusted local checkouts of tau2-bench and EVA-Bench-mix, then configure the
paths and model credentials described in [README.md](README.md):

```sh
export CS_TAU2_ROOT=/path/to/tau2-bench
export CS_TAU2_PYTHON=/path/to/tau2-python
export EVA_BENCH_ROOT=/path/to/EVA-bench-mix

CS_TAU_DOMAINS=eva_airline CS_TAU_CONCURRENCY=8 \
  CS_TAU_USER_MODEL=gpt-5.6-luna CS_TAU_JUDGE_MODEL=gpt-5.6-luna \
  CS_TAU_OUTPUT_DIR=/private/tmp/eva-airline-three-way \
  node examples/customer-service/benchmark/run-full.mjs
```

Set `CS_TAU_USER_API_BASE`, `CS_TAU_JUDGE_API_BASE` and their corresponding
`*_API_KEY_ENV` names when the simulator/judge use a separate OpenAI-compatible
endpoint. Do not commit the output directory. The manifest pins source/config
fingerprints, selected domains, model names, concurrency, retries and every
attempt outcome.
