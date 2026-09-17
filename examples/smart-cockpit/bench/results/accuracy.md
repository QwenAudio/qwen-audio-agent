# Accuracy results

This is the maintained accuracy-results page for both example READMEs.
It combines explicitly identified reference records, not one new run of every
model. Documentation update: **2026-09-14**. No live model test was run as part
of this documentation update.

See the [Benchmark guide](../README.md) for definitions and reproduction,
and [historical snapshots](accuracy-history.md) for earlier tables.

## Short cases — full-case pass

86 cases (62 single-turn and 24 short multi-turn), 111 user turns, 92 expected
calls covering 34 tools. A case passes only when the calls, arguments, turn/path
assignment, no-tool behavior and specified state assertions all pass.

| Domain | Test cases | Realtime-plus + Harness | Realtime-plus | Text qwen3.7-plus | Text qwen3.8-flash | Text qwen3.8-max |
|---|---:|---:|---:|---:|---:|---:|
| Vehicle | 24 | 100.00% (24/24) | 100.00% (24/24) | 95.83% (23/24) | 100.00% (24/24) | 100.00% (24/24) |
| Music | 18 | 94.44% (17/18) | 94.44% (17/18) | 94.44% (17/18) | 94.44% (17/18) | 100.00% (18/18) |
| Navigation | 36 | 97.22% (35/36) | 91.67% (33/36) | 100.00% (36/36) | 100.00% (36/36) | 91.67% (33/36) |
| Weather | 8 | 100.00% (8/8) | 100.00% (8/8) | 100.00% (8/8) | 100.00% (8/8) | 87.50% (7/8) |
| Overall | 86 | 97.67% (84/86) | 95.35% (82/86) | 97.67% (84/86) | 98.84% (85/86) | 95.35% (82/86) |

Source: the [2026-09-13 Benchmark snapshot](https://github.com/QwenAudio/qwen-audio-agent/blob/766baeb1f438ff0ba73102d98f5016e239c06e21/examples/smart-cockpit/bench/README.md),
plus the separate qwen3.7-plus run described below. The historical snapshot's
raw accuracy traces are not committed here. These are recorded full-case
results, not recalculations from the newer team-supplied per-turn summary.

Music has only 18 cases: 94.44% means 17/18, not evidence that the models failed
on the same case. The qwen3.7-plus trace failed the artist-query case because it
passed a song title instead of the expected artist name; the original Harness
report names an unsupported-source case. Parameter mismatch with the gold
answer is not, by itself, proof that the user intent was misunderstood.

## Long dialogue — per-turn tool behavior

Unlike short cases, this suite has separately designed conversations covering
22 tools: 10 cases × 50 turns = 500 turns, comprising 250 tool-required and
250 no-tool turns. A turn passes if its calls and parameters match with no
missing/extra calls; a no-tool turn must make zero calls. Calls are not matched
across turns. State and spoken-response quality are not included in this metric.

| Subject | Overall turn accuracy | Tool-required turn pass | No-tool turn correctness |
|---|---:|---:|---:|
| Realtime-plus + Harness | 99.80% (499/500) | 100.00% (250/250) | 99.60% (249/250) |
| Realtime-plus | 99.20% (496/500) | 98.40% (246/250) | 100.00% (250/250) |
| Text qwen3.7-plus | 98.40% (492/500) | 97.60% (244/250) | 99.20% (248/250) |
| Text qwen3.8-flash | 98.60% (493/500) | 98.80% (247/250) | 98.40% (246/250) |
| Text qwen3.8-max | 98.60% (493/500) | 98.00% (245/250) | 99.20% (248/250) |

Source: team-provided per-turn aggregates received on **2026-09-14**, except
qwen3.7-plus, which was rescored from its local trace. The other four rows do
not have matching raw traces or complete run metadata in this checkout; their
counts are reported as supplied, not independently reconstructed from the old
strict-sequence tables. The collection dates and exact settings of those four
runs must be confirmed from their original reports before a controlled comparison.

Realtime-plus means `qwen-audio-3.0-realtime-plus`; Harness adds the production
Gateway/tool path. This is a controlled scenario result, not a general model
ranking or evidence that extra history improves accuracy. The long aggregate
includes early turns, repeats utterances and expects at most one call per turn;
see [coverage limits](../README.md#coverage-limits).

## Supplemental local runs and audit trail

These runs used benchmark revision
`766baeb1f438ff0ba73102d98f5016e239c06e21`, Text input, the committed domain
routing, thinking enabled, four concurrent cases per suite and a 60-second
request timeout. Calls within a conversation remained serial. Both used public
model aliases without a returned immutable model snapshot. Both completed all
scheduled turns without request/case errors. Their local artifacts are named
below for provenance; they are not published raw traces in this results folder.

- **qwen3.7-plus, 2026-09-13:** local record
  `reports/qwen3.7-plus-20260913.bhMFEM/`, containing `short.json`, `long.json`,
  `run-manifest.json` and a run README. Short/long suites ran concurrently.
  The short full-case result is 84/86. Offline same-turn rescoring of the long
  trace gives 492/500 = 244/250 tool-required + 248/250 no-tool turns.
- **qwen3.8-flash repeat, 2026-09-14:** local record
  `reports/qwen3.8-flash-repeat-20260914.TX4vdR/`, containing `long.json`,
  `summary.json`, `run-manifest.json` and a run README. Only the long suite ran.
  Original scores were independently recomputed before same-turn rescoring.

The Flash repeat is deliberately kept separate from the team's Flash row:

| Record | Overall turn accuracy | Tool-required turn pass | No-tool turn correctness |
|---|---:|---:|---:|
| Local Flash repeat | 98.60% (493/500) | 97.60% (244/250) | 99.60% (249/250) |

Identical overall accuracy does not make these the same run: the subgroup
counts differ. Do not mix the repeat's numerator with the team's subgroup rates.
The repeat's legacy strict tool score is 75.20% (188/250), aligned tool score
100.00% (250/250), and aligned argument score 98.80% (247/250), with four extra
calls. These diagnose sequence drift; they are not the per-turn metric above.

## Reproduction status

The runner still outputs legacy full-case/sequence scores. The long table is
an offline per-turn reaggregation, not a change to the scorer or runner in this
documentation update. For the procedure see [scoring](../README.md#scoring).
Publishing the matching sanitized traces and run manifests is needed to make
every accuracy row independently reproducible from a clean checkout.

By contrast, the [latency report](voice-surface-short-20260911.json.md) has
committed timing data and an offline export test. Accuracy traces, timing data,
and software test pass counts must not be substituted for one another.
