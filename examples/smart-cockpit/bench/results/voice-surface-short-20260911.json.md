# Short frontend/backend tool latency

Same business path as a normal example run: navigation places and weather use the real Amap MCP, driving routes use the real Amap REST API, while music and vehicle keep the example handlers. No fixed route or canned weather was injected.

Realtime model: qwen-audio-3.0-realtime-plus; backend model: qwen3.8-flash.

Unit: seconds. Before = speech PCM end to the latest service.execute start in the turn; after = the same zero point to the latest resolve/reject once every invoked tool has finished. Neither includes the following MCP response transport, the reply audio or backend task terminal states, and neither means the physical action completed.

Turns count independently and the cold first turn is kept. With several tools in one turn the latest start and latest end are used rather than summed, so the two endpoints may belong to different concurrent tools. Each surface averages its own timestamped responses without filtering on tool match or outcome; the difference is backend minus frontend.

A turn with no tool call or a missing timestamp shows — and is never counted as zero. Failed returns are still timed, so an after value does not imply business success. The surfaces may hold different samples, so read the valid counts as well, especially for small domains.

92 task turns; 14 chitchat turns and 5 clarification/refusal turns stay in the data without entering the task means. Scores, transcripts, tool payloads and process logs are not shown.

Batch sources: this is an offline merge of per-domain runs measured at different times, not one continuous run. Means are recomputed from the responses instead of averaging batch means.

voice-surface-short-vehicle-music-20260911-example-dual.json; 2026-09-11T04:57:06.459Z; 42 cases; no recovery.

voice-surface-short-navigation-weather-20260911-example-dual.json; 2026-09-11T05:32:18.376Z; 44 cases; no recovery.

## Before execution

| Domain | Task turns | Frontend before/s | Backend before/s | Difference (backend − frontend)/s | Frontend valid | Backend valid |
| --- | --- | --- | --- | --- | --- | --- |
| all | 92 | 1.317 | 3.363 | 2.046 | 90 | 68 |
| vehicle | 23 | 1.539 | 3.277 | 1.738 | 23 | 22 |
| music | 17 | 1.153 | 2.506 | 1.353 | 17 | 15 |
| navigation | 44 | 1.303 | 3.860 | 2.557 | 44 | 30 |
| weather | 8 | 1.034 | 3.209 | 2.175 | 6 | 1 |

[Per-turn CSV, before execution](voice-surface-short-20260911.json.before.csv)

## After execution

| Domain | Task turns | Frontend after/s | Backend after/s | Difference (backend − frontend)/s | Frontend valid | Backend valid |
| --- | --- | --- | --- | --- | --- | --- |
| all | 92 | 1.480 | 3.560 | 2.080 | 90 | 68 |
| vehicle | 23 | 1.539 | 3.277 | 1.738 | 23 | 22 |
| music | 17 | 1.154 | 2.506 | 1.353 | 17 | 15 |
| navigation | 44 | 1.616 | 4.301 | 2.685 | 44 | 30 |
| weather | 8 | 1.187 | 3.361 | 2.174 | 6 | 1 |

[Per-turn CSV, after execution](voice-surface-short-20260911.json.after.csv)
