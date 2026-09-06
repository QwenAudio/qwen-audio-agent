# Quick-query lane RFC

Status: proposed

This RFC defines a small, read-only lane between the Realtime frontend and the
configured backend Agent. It is intended for questions that need the backend's
current knowledge or status but do not justify a user-visible Work item.

## Goals

- Answer one bounded, read-only question without appending a Work to the owner
  FIFO queue.
- Reuse the owner's persistent coordinator Session so the answer follows the
  configured backend and its available read-only tools.
- Keep the foreground conversational: acknowledge the lookup immediately, then
  deliver the verified answer through the normal Agent Delivery path.
- Put a hard 15-second budget around the fast path. If it expires, cancel the
  lookup and promote the same question to a normal Work.

## Non-goals and safety boundary

- No file writes, code changes, device actions, purchases, permissions, or
  multi-step orchestration belong in this lane. Those requests remain on
  `spawn_thinking`.
- The frontend model selects the lane from the user's intent; it cannot select
  a backend Session, execution strategy, or tool.
- A quick lookup never receives a user-visible Task ID. A promoted Work gets a
  normal Task ID and uses the existing notification, cancellation, and
  persistence paths.

## Lifecycle

```text
quick_lookup(question)
       |
       +--> immediate receipt --> short foreground acknowledgement
       |
       +--> coordinator Session, priority 10
                 |
                 +--> answer before 15s --> Agent Delivery response
                 |
                 +--> timeout ----------> cancel + create normal Work
                                            + Task announcement
```

The lane is priority-aware only while waiting for the coordinator Session. A
currently running backend turn is not forcibly interrupted; after it releases
the Session, a quick lookup is selected ahead of ordinary queued turns. A
newer user turn or explicit interruption invalidates the lookup and drops its
late result.

## Result contract

The adapter returns ordinary backend content and optional content blocks. The
Gateway owns the user-facing envelope and tells the Realtime frontend to answer
only from that result. A lookup failure is not presented as a guessed answer.

The timeout promotion keeps the original normalized question and current owner
context, so the normal Work path can finish after the fast-path budget without
duplicating the request.

## Delivery and observability

The immediate receipt is correlated with the current voice turn. The eventual
answer uses `origin=quick-query` and the same turn correlation. It waits for a
safe duplex insertion window and is discarded when the turn generation is no
longer current. Adapter diagnostics may record duration and outcome, but must
not persist question content or provider-specific internal IDs in the public
Task surface.

## PR split

1. This RFC: semantics, boundary, lifecycle, timeout, promotion, and delivery.
2. Implementation: `quick_lookup`, priority coordinator scheduling, timeout
   promotion, cancellation, and conformance tests.
3. Camera follow-up: one-shot photo questions, camera state feedback, and
   privacy wording; it is independent of the quick-query lane.

