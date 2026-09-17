# Published benchmark records

| Record | Purpose | Reproducibility |
|---|---|---|
| [Accuracy](accuracy.md) | Reference short-case scores and the 2026-09-14 long per-turn update | Provenance is listed per batch; matching raw accuracy traces are not all committed. |
| [Tool-placement latency, 2026-09-11](voice-surface-short-20260911.json.md) | Same tools, frontend direct vs. backend delegation | [Timing JSON](voice-surface-short-20260911.json) re-exports offline to Markdown, HTML and CSV. |
| [Accuracy history](accuracy-history.md) | Earlier recorded tables and legacy labels | Preserved snapshots with source commits, not current headline metrics. |

Use the [Benchmark guide](../README.md) for metric definitions and commands.
Update accuracy numbers in one place; regenerate latency displays from the
timing data. Do not hand-edit measurements to make different runs agree.
