# Composer Dictation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add privacy-preserving, opt-in Qwen ASR dictation to the Web and TUI composers without changing the existing conversation submission path.

**Architecture:** A shared deterministic composer model handles revisions, recent-range edits, terminal commands, and receipts. The Gateway hosts a fail-closed dictation session backed by an optional provider adapter. Web and TUI route their existing microphone stream and existing composer submit callback through a small client controller while dictation is active.

**Tech Stack:** Node.js ESM, `node:test`, WebSocket (`ws`), React 19, Vite, existing Gateway/Memory services.

---

### Task 1: Lock the shared composer contract

**Files:** Create `shared/dictation-contract.mjs`, `test/dictation-contract.test.mjs`; modify `shared/realtime-events.mjs`, `server/src/core/gateway-protocol.mjs`.

1. Write failing tests for revision conflicts, unique recent-range edits, standalone/punctuation-bounded send commands, the Chinese negative `把文件发送`, and commit receipt dedupe.
2. Run `node --test test/dictation-contract.test.mjs` and confirm failure.
3. Implement the smallest deterministic contract and additive `dictation.*` event names.
4. Re-run the focused test.

### Task 2: Add the provider adapter and fail-closed server session

**Files:** Create `server/src/voice/dictation-session.mjs`, `server/src/voice/providers/qwen-asr-realtime.mjs`, related tests; modify provider registry, DashScope provider, config, application, and realtime gateway.

1. Write failing fake-provider tests for state transitions, every active-state timeout, late messages after pause/cancel/error/stop, stop-then-resume rejection, commit dedupe, external suspension, and zero downstream conversation/Memory calls before a successful commit.
2. Write failing registry/protocol tests proving disabled-noop and optional adapter validation.
3. Implement a session factory with injected clock/provider and no transcript logging.
4. Implement the Qwen3 ASR Realtime adapter using PCM16/16 kHz, server VAD, dedicated credentials/config, and official event normalization.
5. Wire the session to the existing Gateway socket and external suspension callback; advertise `2.1.0` capabilities only when enabled.
6. Re-run focused server tests.

### Task 3: Reuse Memory policy for explicit submitted corrections

**Files:** Create `server/src/conversation/memory-policy.mjs` and tests; modify tool-call handler, application, and dictation session.

1. Write failing spy tests showing zero Memory/audit calls for partial, cancel, timeout, and failed submit; one call only after a successful explicit correction receipt; sensitive corrections fail closed.
2. Extract the existing sensitive-memory predicate without changing its behavior.
3. Apply exact durable-fact replacements only after commit acknowledgement, through `FrontendMemoryService`, and write metadata-only audit records.
4. Run focused Memory and tool tests.

### Task 4: Wire the Web composer

**Files:** Create `web/src/useComposerDictation.js` and tests; modify `MultimodalComposer.jsx`, `App.jsx`, `useRealtimeVoice.js`, and CSS.

1. Write failing behavior tests for disabled-noop, real shortcut/button wiring, underlined partial, final locking, keyboard settlement, revision rejection, submission-once, continuous mode, ownership restoration, and suspension.
2. Add a ref-based composer API that preserves the existing `onSend(parts)` path.
3. Route captured PCM to dictation while active, otherwise to main Realtime; never run both.
4. Render visible state/errors and partial preview only when capability and flag are present.
5. Run the Web suite and build.

### Task 5: Wire the TUI composer

**Files:** Modify `tui/src/index.mjs` and `tui/test/index.test.mjs`.

1. Write failing behavior tests for shortcut/state, draft/final/partial operations, mute and ownership preservation, suspend, disabled-noop, and one-submit semantics. Read buffered stdout until the expected marker rather than assuming one `stdout.read()` chunk under Node 26.
2. Extend the persistent renderer with a narrow composer API and pre-edit settlement hook.
3. Route its existing audio bridge exclusively to dictation while active and restore the original capture state on normal exit.
4. Run the TUI suite on the supported Node runtime.

### Task 6: Contract, privacy, and operator documentation

**Files:** Modify `docs/contract.md`, `docs/contract.zh.md`, `docs/configuration.md`, `docs/configuration.zh.md`, `docs/reference/memory.md`, `docs/reference/memory.zh.md`, and `PRIVACY.md`.

1. Document protocol events, dynamic capabilities, configuration, 45-second timeout, command boundary, microphone transfer, provider failure behavior, and zero-history privacy rules.
2. Explicitly record excluded Desktop/global-shortcut/OS-permission/history/fallback behavior.
3. Run doc-sensitive contract tests and `git diff --check`.

### Task 7: Verify and deliver

1. Run every new focused test separately.
2. Run `npm test`, `npm run lint`, `npm run build`, and `git diff --check` from a clean environment without provider credentials.
3. Review `git diff`, commit, and push the new branch.
4. Open a new PR titled with `ZQ-77`; include `Closes ZQ-77` and `Related #165`.
5. Report the base SHA, head commit, PR, exact results, and residual limitations.
