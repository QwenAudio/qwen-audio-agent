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
3. Before presenting any later response audio/text **or dispatching its tools**,
   the Gateway checks outstanding reviews. If necessary, it cancels the
   speculative response using the existing frontend cancellation mechanism and
   suppresses all its subsequent events. Policy cancellation retains the cancelled
   response ID until response/connection reset. Late created, text/audio, tool,
   done or ID-bound error events cannot reactivate it, consume the replacement
   waiter, or release the replacement response slot. Ordinary cancellation
   behavior is unchanged when this policy-specific retirement option is unused.
4. After review settles, the Gateway injects the original routing paragraph, bound conversation evidence, and an actionable
   instruction to try a relevant dedicated tool or submit the request through
   `spawn_thinking` instead of merely apologizing or repeating the refusal
   with the existing `injectDelivery(route=context)` mechanism. It then requests
   regeneration for the latest user turn using `ensureResponse`. It does not
   read the review JSON aloud or edit the system prompt. Stale/disconnected
   sessions cannot resume. A turn superseded while waiting cannot resume later.
5. Review timeout, endpoint error, or invalid response fails open. A timed-out
   request is aborted and any late verdict is discarded. If generation was
   already cancelled, it is regenerated without that verdict. Timeout does not
   erase corrections from other successful reviews.

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
response: current output is unbuffered, next speculative audio/tools are blocked,
correction precedes regeneration, timeout/error fails open, late verdicts are
ignored, newer user turns win, and disabled mode has no review side effects.
These tests do not measure JEV accuracy or live inference latency.
