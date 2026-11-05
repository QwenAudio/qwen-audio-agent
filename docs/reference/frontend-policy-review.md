# Optional JEV frontend policy review

This opt-in monitor checks completed frontend reply text asynchronously. It does
not delay or buffer the reply being checked. It checks backend-interaction rules
from the actual main system prompt (`Routing`, `Background work`, and relevant
`Role` restrictions) and whether a reply repeats an error the user previously
explicitly corrected. Each rule receives a content-derived ID; there is no second
copy of system policy to maintain.

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
2. Each applicable rule is a separate JEV question. Another question checks
   repeated user corrections. The Gateway validates model identity, input hash,
   question IDs, primitive and option order. Only explicit `violation` answers
   produce corrections; uncertain answers do not.
3. Before presenting any later response audio/text **or dispatching its tools**,
   the Gateway checks outstanding reviews. If necessary, it cancels the
   speculative response using the existing frontend cancellation mechanism and
   suppresses all its subsequent events.
4. After review settles, the Gateway injects the violated rules and bound evidence
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
