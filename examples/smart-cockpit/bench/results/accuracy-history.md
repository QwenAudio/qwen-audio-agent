# Accuracy history — preserved snapshots

These are earlier recorded results, not alternative definitions of the current
headline accuracy. Numerical cells are preserved from the original documents.
Read the [current results page](accuracy.md) and [metric definitions](../README.md#scoring)
before comparing them.

## Example README snapshot — 2026-09-10

Source: [commit 94d6cd3, example README](https://github.com/QwenAudio/qwen-audio-agent/blob/94d6cd372379f9c889ea8d6f6190e4cd45122adb/examples/smart-cockpit/README.md).
The short table did not identify the Text model in its column heading; do not
infer a model alias or thinking setting that the record does not establish.
The matching raw accuracy traces are not committed with this snapshot.

| Domain | Cases | Expected calls | Text pass rate | Text actual calls | Realtime pass rate | Realtime actual calls |
|---|---:|---:|---:|---:|---:|---:|
| Vehicle | 24 | 23 | 100.00% | 23 | 100.00% | 23 |
| Music | 18 | 17 | 100.00% | 17 | 100.00% | 17 |
| Navigation | 36 | 44 | 100.00% | 44 | 97.22% | 44 |
| Weather | 8 | 8 | 100.00% | 8 | 100.00% | 8 |
| Overall | 86 | 92 | 100.00% | 92 | 98.84% | 92 |

| Model | Calls exp/act | Tool acc | Aligned tool | Arg acc | Aligned arg | Missing/extra | Final state | Checkpoints | Silent turns |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Text `qwen3.8-flash` | 250 / 252 | 88.80% | 100.00% | 91.20% | 100.00% | 0 / 2 | 100.00% | 100.00% | 90.00% |
| Realtime `qwen-audio-3.0-realtime-plus` | 250 / 246 | 71.20% | 98.40% | 76.00% | 98.40% | 4 / 0 | 100.00% | 80.00% | 100.00% |

## Detailed Benchmark snapshot — 2026-09-13

Source: [commit 766baeb, Benchmark README](https://github.com/QwenAudio/qwen-audio-agent/blob/766baeb1f438ff0ba73102d98f5016e239c06e21/examples/smart-cockpit/bench/README.md).
The original report names local runs such as `cockpit-text-flash-short.json`,
`cockpit-text-flash-long.json`, `cockpit-text-max-long-rerun2.json`, and
`harness-short-fixed.json`; these raw traces are not part of this committed
documentation. The tables below retain their original labels for traceability.

### Short full-case results

| Domain | Cases | Expected calls | Text `flash` pass | Text `max` pass | Realtime pass | Harness pass |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Vehicle | 24 | 23 | 100.00% (24/24) | 100.00% (24/24) | 100.00% (24/24) | 100.00% (24/24) |
| Music | 18 | 17 | 94.44% (17/18) | 100.00% (18/18) | 94.44% (17/18) | 94.44% (17/18) |
| Navigation | 36 | 44 | 100.00% (36/36) | 91.67% (33/36) | 91.67% (33/36) | 97.22% (35/36) |
| Weather | 8 | 8 | 100.00% (8/8) | 87.50% (7/8) | 100.00% (8/8) | 100.00% (8/8) |
| Overall | 86 | 92 | 98.84% | 95.35% | 95.35% | 97.67% |

### Short call-level diagnostics

| Subject | Tool acc | Aligned tool | Arg acc | Final state | Silent turns | Calls exp/act | Missing/extra |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Text `qwen3.8-flash` | 98.91% | 98.91% | 98.91% | 98.84% | 100.00% | 92 / 91 | 1 / 0 |
| Text `qwen3.8-max` | 95.65% | 100.00% | 94.57% | 97.67% | 100.00% | 92 / 97 | 0 / 5 |
| Realtime | 98.91% | 100.00% | 96.74% | 100.00% | 98.84% | 92 / 95 | 0 / 3 |
| Harness | 98.91% | 100.00% | 98.91% | 100.00% | 98.84% | 92 / 95 | 0 / 3 |

### Long conversation diagnostics

| Subject | Pass | Calls exp/act | Tool acc | Aligned tool | Arg acc | Aligned arg | Missing/extra | Final state | Checkpoints | Silent turns |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Text `qwen3.8-flash` | 60.00% (6/10) | 250 / 256 | 71.60% | 100.00% | 76.00% | 99.60% | 0 / 6 | 90.00% | 100.00% | 70.00% |
| Text `qwen3.8-max` | 50.00% (5/10) | 250 / 254 | 82.40% | 100.00% | 84.80% | 98.80% | 0 / 4 | 100.00% | 95.00% | 80.00% |
| Realtime | 60.00% (6/10) | 250 / 246 | 71.20% | 98.40% | 76.00% | 98.40% | 4 / 0 | 100.00% | 80.00% | 100.00% |
| Harness | 90.00% (9/10) | 250 / 251 | 95.60% | 100.00% | 96.40% | 100.00% | 0 / 1 | 100.00% | 100.00% | 90.00% |

## Reading the old labels

- `Pass` is full-case pass, including state assertions, not per-turn accuracy.
- `Tool acc` and `Arg acc` compare calls by their position in the whole case.
  An inserted call can shift later comparisons. Argument accuracy checks
  parameter matches separately; it is not joint tool-and-argument correctness.
- `Aligned tool` / `Aligned arg` match same-name calls in order across the
  conversation. They do not enforce the correct turn unless that is checked
  separately, and extras must be reported alongside them.
- `Final state` is per-case final-state success; `Checkpoints` is the fraction
  of individual intermediate state checkpoints passed.
- `Silent turns` is the percentage of **cases** with no calls on any marked
  no-tool turn, not the fraction of individual no-tool turns answered correctly.

The Flash values 88.80% and 71.60% both describe strict sequence tool selection,
but belong to different recorded runs. They must not be combined into one run
or presented as interchangeable scores. The 2026-09-14 per-turn update uses a
different aggregation; it cannot be reconstructed from these summary cells alone.

The old report attributed a Realtime/Harness gap to retained navigation context.
That is a hypothesis, not an ablation result: the prompt, tool outputs, runtime
guards, and observed execution point also differ. Historical changes to retry
handling and argument normalization likewise need the run revision attached.
