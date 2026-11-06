# Optional JEV frontend policy review

This opt-in monitor currently checks **one issue only**: the frontend claims it
cannot carry out an actual user request without trying a relevant dedicated tool
or delegating it to the backend. It derives one rule from the first `Routing`
paragraph of the main system prompt, beginning “仅当直接回答就能满足用户请求时”.
The main prompt itself is unchanged. Other system rules and repeated-user-
correction checks are currently excluded.

The reply under review is not buffered. Review runs asynchronously and can correct
the following response using the existing cancellation and notification mechanisms.

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
| `QWEN_AUDIO_POLICY_REVIEW_TIMEOUT_MS` | `1500` | Positive request budget in milliseconds, measured from reply completion; timeout releases the next response. |

The endpoint must be reachable **from the Gateway**. A remote worker's loopback
address is not the local Gateway's loopback. This feature does not deploy a model,
allocate GPUs, enable a proxy, or switch to another model automatically. Run an
existing Jarvis-compatible JEV-Omni decision service with its own dependencies and
model weights; this repository does not bundle those weights. The service must
support `choice` questions with `violation`, `ok`, and `uncertain` options.

## Ordering and notification

1. Completed reply text, response/turn IDs, retained user/assistant history,
   backend task state/results and recent frontend tool events form the review
   packet. The current reply continues playing normally.
2. There is exactly one JEV choice question about unattempted refusal. It does
   not judge other violations in that paragraph, business/task cancellation,
   repeated corrections or exposure of internal structure. The Gateway validates model identity, input hash,
   question IDs, primitive and option order. Only explicit `violation` answers
   produce corrections; uncertain answers do not.
3. Before presenting a later response (including its start, audio/text, completion
   and tool calls), the Gateway buffers its events until outstanding reviews finish.
   An `ok`/`uncertain`, timeout or reviewer error releases the original buffered
   events in order, without cancelling or regenerating that response. A review
   started by replaying a buffered completion gates the following response too.
   User interruption discards superseded buffered output.
4. Only a validated violation discards speculative output and uses existing
   cancellation. The correction packet contains the original turn/response IDs,
   full reviewed assistant text and retained conversation history. Problem and
   remediation text are fixed Gateway templates selected by rule ID, never
   free-form JEV instructions. The Gateway immediately injects it through
   `injectDelivery(route=context)` and requests a replacement with `ensureResponse`.
   Response instructions require a short, natural acknowledgement that the earlier
   answer will be corrected, actual tool/backend attempts for that request, then
   an answer to the latest request. They forbid exposing the reviewer, backend
   structure or tool names and repeating operations already completed.
5. If the user is speaking, replacement waits for native `speech_stopped`.
   Only this JEV replacement opts into event-driven recovery of an input/speech-busy
   response refusal. The provider requires a unique pending local request (no
   response already assigned to its waiter), waits for native `speech_stopped`,
   then uses the existing response retry mechanism and its existing three-retry
   limit. A stop received after submission but before the rejection also qualifies.
   It rechecks connection/queue generation and the original current-turn gate;
   cancellation/reset invalidates the wait. It never resends a business tool or
   context item and adds no backoff timer. Ordinary agent/tool notifications keep
   their existing refusal behavior. Unassociated errors are not silently retried.
6. If a user interrupts an in-flight repair, its correction remains required for
   the latest turn after speech stops. A correlated repair response claims only
   its matching input candidate, preventing a false no-response watchdog for
   that input. Disconnected sessions cannot replay buffers or start replacements.
7. Review timeout, endpoint error, or invalid verdict fails open. Timed-out
   requests are aborted and late verdicts ignored; valid corrections from other
   reviews are retained.

No explicit playback-clear is required for speculative audio: the guard runs
before that response's audio is forwarded. Audio already heard from the reviewed
reply cannot be recalled. Input reception continues while review is pending.
Models/providers must support cancellation, context item injection and client
response creation for the full correction-and-regeneration flow. This monitor
uses the existing provider mechanisms; it does not add a separate voice transport.
If context injection fails, an error is logged and the correction is also supplied
as response instructions to the regeneration request.

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
These tests do not measure JEV accuracy or live inference latency.

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
