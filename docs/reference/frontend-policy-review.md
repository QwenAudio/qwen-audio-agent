# Optional JEV frontend policy review

This opt-in monitor currently checks **one issue only**: the frontend claims it
cannot carry out an actual user request without trying a relevant dedicated tool
or delegating it to the backend. It derives one rule from the first `Routing`
paragraph of the main system prompt, beginning “仅当直接回答就能满足用户请求时”.
The main prompt itself is unchanged. Other system rules and repeated-user-
correction checks are currently excluded.

The reply under review streams normally. After its playback/output-completion boundary,
one asynchronous review releases or rejects all of its tools and guards the following
response using existing cancellation and notification mechanisms.

## Configure

Set these variables on the Gateway process before starting it:

```sh
QWEN_AUDIO_POLICY_REVIEW=on \
QWEN_AUDIO_POLICY_REVIEW_ENDPOINT=http://127.0.0.1:8810/decide \
QWEN_AUDIO_POLICY_REVIEW_TIMEOUT_MS=1500 \
node cli/bin/qwenaudio.mjs gateway
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `QWEN_AUDIO_POLICY_REVIEW` | `off` | Enable the monitor (`on` or `off`). |
| `QWEN_AUDIO_POLICY_REVIEW_ENDPOINT` | empty | Full URL of the JEV-Omni `/decide` service; required when enabled. |
| `QWEN_AUDIO_POLICY_REVIEW_TIMEOUT_MS` | `1500` | Positive budget in milliseconds for each JEV request; timeout fails open after the playback boundary, never during boundary collection. |

The endpoint must be reachable **from the Gateway**. A remote worker's loopback
address is not the local Gateway's loopback. This feature does not deploy a model,
allocate GPUs, enable a proxy, or switch to another model automatically. Run an
existing Jarvis-compatible JEV-Omni decision service with its own dependencies and
model weights; this repository does not bundle those weights. The service must
support `choice` questions with `violation`, `ok`, and `uncertain` options.

## One review after playback, with all tools deferred

When enabled, Gateway holds every frontend tool call belonging to one response,
including `spawn_thinking` and inline MCP business tools. It does not review or
execute each tool at its argument-complete boundary. The response's own audio
continues streaming normally while all of its calls remain queued.

Gateway waits for the completed native response and final received transcript.
For audio clients with playback receipts it additionally waits for the accepted
`playback.ended` event, not merely `response.audio.done` or `response.done`.
Clients without playback receipts (including the current whole-response benchmark)
use completed output reception as their boundary; Gateway cannot certify actual
speaker playback for such a client. Text/tool-only replies need no audio receipt.
A native completed output containing final text can substitute for a separate
transcript-done event. Different content parts are accumulated in output order.

The one JEV packet has `phase=played_response`, the response/turn IDs, full retained
text/history, real execution evidence and **all** queued calls in `proposed_tools`
marked `executed=false`. Only the existing unattempted-refusal routing rule is
checked. A pending relevant attempt must not itself be treated as a refusal just
because Gateway is waiting for approval. This is not an ASR parameter check or a
business-authorization audit. Current validation targets Qwen only.

An explicit approval releases the queued calls through existing validation and
execution. `uncertain`, reviewer error and **JEV-request** timeout still fail open
as previously configured. The review budget starts at the review request, not at
the first tool argument or during audio playback. Waiting for missing response,
transcript or playback completion is never interpreted as approval. No deferred
call executes without first obtaining this shared review outcome. Interrupted or
obsolete calls are not executed; connection close releases unexecuted waiters.
Missing native terminals or playback receipts remain an incomplete boundary until
interruption/disconnection; they are not silently repaired or marked complete.

A rejected verdict stops/retire-protects speculative next-response generation
immediately. None of this response's queued calls executes. Each existing tool
result reports `policy_review_rejected`, `executed=false`, `retryable=true` and the
fixed rule/remedy. After those results settle, Gateway reuses its correction
context and response-generation mechanisms. Instructions require the frontend to
first fix and re-call the old unexecuted tools, then briefly clarify the earlier
possible error to the user, and finally address the latest request. The model
chooses the corrected calls; Gateway does not automatically repeat old arguments.
If the user is speaking, regeneration waits for native `speech_stopped`. A new
input preserves the correction requirement; obsolete buffered audio is discarded.
For a violation without tools, the existing clarify/attempt/latest-request remedy
applies. The reviewed audio already heard by the user is not recalled.

While a source is awaiting playback or review, later response events (start,
audio/text, completion and tool calls) are buffered before presentation/dispatch.
The source itself remains allowed to finish streaming, preventing a client-side
cycle where held tools block collection of its remaining audio/transcript. On a
passing/fail-open result, subsequent output is replayed in order; only violations
cause cancellation/regeneration. Context and cancellation continue using existing
provider mechanisms, including native speech-busy recovery.

Backend progress/result generation retains source task/turn/response association.
For newly submitted tasks the shared source verdict already exists before their
submission. Legacy/already-executed results remain factual if routed into a
correction: they must not be described as unexecuted or repeated due to later
speech rejection. Notification delivery is acknowledged only by actual result
presentation. Unrelated notifications are not a global source-review barrier.

The default switch remains off, no main prompt or ASR-review code is changed.
The cancellation handling from this branch remains JEV-specific; this change does
not certify all ordinary user interruption, same-ID reuse or adapter issues.

## Scope and limits

Positive examples include “I cannot access or change your booking” with no
related tool/delegation evidence. Necessary clarification, knowledge answers,
truthful actual tool failure or backend inability, explicit policy restrictions,
and refused authorization are not this issue. An empty lookup result is not
proof of lacking capability. Only attempts relevant to this request count.

This is a model judgment, not proof of compliance. The reviewer sees the main
system rules and retained session history, not arbitrary prior sessions or
forgotten messages. User corrections are treated as evidence, never new system
instructions. Recent frontend tool evidence is bounded to 100 lifecycle events;
conversation retention follows the existing ConversationSync settings. Truncated
historical evidence can lead to `uncertain`. A successful task does not imply that
all claims in a reply are correct.

With `QWEN_AUDIO_POLICY_REVIEW=off`, no monitor instance, JEV request, correction
context, cancellation gate or prompt modification is added. This experimental branch starts from upstream `76aec3e3`, before the separate
ASR-review changes; it does not include or modify that feature. Enabling this feature adds model calls and may delay or restart
the **following** response; benchmark results should record this configuration
and remain separate from historical runs.

## Verification

```sh
node --test server/test/frontend-policy-review.test.mjs server/test/realtime-session-runtime.test.mjs
```

Tests use a deterministic decision mock and a protocol-compatible fake endpoint
response: current output is unbuffered; next response events are held and replayed in order
on ok/uncertain/timeout/error; violations inject fixed remediation before
regeneration; user interruption retains repair for the latest turn; input-busy
recovery waits for native speech-stopped and respects cancellation/reset; late
verdicts are ignored; disabled mode has no review side effects.
Tests also cover multi-tool shared admission after playback, complete transcript aggregation, rejected-call receipts, stale turns, immediate next-response cancellation, user-speaking waits, disconnect cleanup, and reviewer timeout/error fail-open. These tests do not measure JEV accuracy or live inference latency; this commit has not been validated by a live Qwen evaluation.

The lifecycle repair branch also contains earlier tool-result queue and old-socket
isolation fixes. This playback-gate change has deterministic tests; it does not
certify recovery of the historical 144 failed cases or fix all same-ID reuse and
adapter completion issues. Keep new evaluations separate from frozen results.

## JEV cancellation outcomes

Only JEV-owned cancellation tracks a cancel request and its captured response
IDs. Its events remain obsolete regardless of whether cancellation wins the race.
A matching `response.done` with `status=cancelled` is explicit cancellation;
`status=completed` means generation finished before cancellation. Both terminal
frames are consumed before obsolete-output filtering so they release the waiting
slot without exposing discarded output. A terminal frame for another response
does not acknowledge the outstanding JEV cancel.

A `no_active_response` error for the outstanding cancel records
`already_inactive`, not cancellation success or successful playback. When an
error supplies `error.event_id`, it must match the sent cancel request; response
ID/param fields must also be compatible when present. With no request ID, the
association is only the outstanding cancel and is logged as such, not promoted
to an explicit per-response receipt. Only captured discarded IDs are removed
from activity; a newer response is preserved.

Missing confirmation uses the existing cancellation recovery/disconnect path;
it never becomes synthetic cancellation success. Diagnostics use
`realtime.policy_cancel` states `awaiting`, `cancelled`, `already_finished`,
`already_inactive`, `terminal`, `unmatched_error`, and `unconfirmed_reset`.

A buffered response which has already completed is explicitly retired by ID
without sending an unnecessary cancel for an empty activity set. This is still
raw-ID retirement, not a solution to upstream ID reuse; the documented identity
limitations and historical-case acceptance requirements remain. Ordinary user
interruption behavior is unchanged by this cancellation-outcome handling.
