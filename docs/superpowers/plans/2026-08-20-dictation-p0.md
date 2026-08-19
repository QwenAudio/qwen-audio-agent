# Composer Dictation P0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in, private dictation to the WebUI and TUI composers through an independent Qwen ASR session.

**Architecture:** Clients remain authoritative for draft text and selection. A small Gateway session validates sequence/revision transitions and adapts a dedicated Qwen-ASR-Realtime WebSocket; only a de-duplicated client-side composer submit enters the existing `input.message` path.

**Tech Stack:** Node.js 22 ESM, `ws`, React 19, Node test runner, Vite.

**Spec:** `docs/dictation-p0.md`

## Global Constraints

- Implement only P0a/P0b for owned Web/TUI composers; do not add desktop/native, P1, P2, or P3 behavior.
- Protocol is additive `2.1.0`; runtime feature flag defaults off.
- No persistent dictation history, OS permission, global shortcut, or synthetic Enter.
- Continuous mode defaults on with a 45-second inactivity timeout.
- ASR failure is visible and falls back only to keyboard input, never the primary Realtime provider.
- Uncommitted/cancelled material has zero conversation, memory, disk, or content-log side effects.

---

### Task 1: Shared protocol, intent parser, and draft operations

**Files:**
- Create: `shared/dictation-protocol.mjs`
- Create: `shared/dictation-draft.mjs`
- Test: `test/dictation-protocol.test.mjs`
- Modify: `shared/realtime-events.mjs`
- Modify: `server/src/core/gateway-protocol.mjs`

**Interfaces:**
- Produces `DictationClientEvent`, `DictationServerEvent`,
  `DICTATION_CAPABILITIES`, `parseDictationIntent(text)`,
  `applyDraftOperation(snapshot, operation)`, and `draftPayloadHash(text)`.
- Intent results are literal `insert`, `replace`, `delete`, `rewrite`, or
  `commit` records; operations always name `operationId` and `baseRevision`.

- [ ] Write table-driven tests whose literal expectations cover Chinese and
  English terminal commands, mid-sentence non-commands, exact replacement and
  deletion, invalid revisions, and stable hashes.
- [ ] Run `node --test test/dictation-protocol.test.mjs`; confirm failures are
  missing modules/exports.
- [ ] Implement the smallest pure protocol/parser/draft modules and add event
  constants/capabilities/version `2.1.0`.
- [ ] Re-run the test and `node --test test/gateway-contract.test.mjs`.

### Task 2: Session state machine and in-process commit receipts

**Files:**
- Create: `server/src/dictation/dictation-session.mjs`
- Create: `server/src/dictation/commit-registry.mjs`
- Test: `server/test/dictation-session.test.mjs`

**Interfaces:**
- `new DictationSession({ send, createTranscriber, rewriteText, now,
  setTimer, clearTimer, timeoutMs })` exposes `handle(event)` and `close()`.
- `CommitRegistry.accept({ commitId, revision, payloadHash })` returns a stable
  first/replay/conflict result and retains receipts only in memory.

- [ ] Write failing tests for legal/illegal lifecycle transitions, monotonic
  client `seq`, one revision-conflict retry, duplicate commits, mid-sentence
  send safety, continuous re-entry, and 45-second pause.
- [ ] Verify RED with `node --test server/test/dictation-session.test.mjs`.
- [ ] Implement minimal state/session/receipt logic without importing
  conversation, memory, filesystem, or logger modules.
- [ ] Verify GREEN and run the protocol tests again.

### Task 3: Dedicated Qwen ASR and stateless rewrite adapters

**Files:**
- Create: `server/src/dictation/qwen-asr-transcriber.mjs`
- Create: `server/src/dictation/stateless-rewriter.mjs`
- Test: `server/test/qwen-asr-transcriber.test.mjs`
- Test: `server/test/dictation-rewriter.test.mjs`

**Interfaces:**
- `createQwenAsrTranscriber(options)` exposes `start`, `appendAudio`, `pause`,
  `resume`, and `close`; callbacks expose delta/final/error without logging
  text.
- `createStatelessRewriter(options)` returns an async `(draft, instruction) =>
  text` function whose request has system/user text only and no tools.

- [ ] Use a fake WebSocket to assert URL/model/auth headers and the exact
  `session.update`, audio append, VAD, and finish event sequence.
- [ ] Assert partial/final/error mapping and that provider errors do not create
  or invoke a primary Realtime frontend.
- [ ] Assert the rewrite HTTP body has no tools, memory, prior messages, or
  persistence callback.
- [ ] Verify RED, implement both adapters, then verify GREEN.

### Task 4: Gateway routing, disabled no-op, and privacy integration

**Files:**
- Modify: `server/src/core/config.mjs`
- Modify: `server/src/app/gateway-application.mjs`
- Modify: `server/src/voice/realtime-gateway.mjs`
- Test: `server/test/dictation-gateway.test.mjs`
- Test: `server/test/config.test.mjs`

**Interfaces:**
- Config fields: `dictationEnabled`, `dictationBaseUrl`, `dictationModel`,
  `dictationApiKey`, `dictationTimeoutMs`, `dictationRewriteModel`.
- `attachRealtimeGateway` accepts an injected `createDictationSession`; it
  owns at most one dictation session per live client connection.

- [ ] Write a real Gateway WebSocket test with fake ASR and spies for
  conversation sync, memory extraction, filesystem snapshot, and logger sink.
- [ ] Assert disabled `dictation.start` neither creates ASR nor changes ordinary
  input behavior; assert cancel/uncommitted transcript has zero side effects.
- [ ] Assert one commit request followed by one ordinary `input.message` creates
  exactly one existing text turn, while replayed `commitId` does not request a
  second submit.
- [ ] Verify RED, add config/routing/cleanup, then verify GREEN plus existing
  Gateway and memory-hook tests.

### Task 5: Reusable client controller and Web composer

**Files:**
- Create: `shared/dictation-client.mjs`
- Create: `web/src/useDictation.js`
- Modify: `web/src/useRealtimeVoice.js`
- Modify: `web/src/MultimodalComposer.jsx`
- Modify: `web/src/App.jsx`
- Modify: `web/src/App.css`
- Test: `web/test/dictation-client.test.mjs`
- Test: `web/test/dictation-composer.test.jsx`

**Interfaces:**
- `createDictationClient({ send, composer, createId })` consumes server events
  and exposes start/pause/resume/cancel plus visible state.
- Composer imperative methods expose `snapshot`, `applyOperation`, and
  `commitDictation`; the last method shares the Send-button submission path.
- `useRealtimeVoice` routes captured audio to exactly one destination:
  primary `audio.append` or `dictation.audio.append`.

- [ ] Write failing controller tests for visible states, seq generation,
  revision conflict acknowledgements, and commitId de-duplication.
- [ ] Write a component test proving one commit request invokes `onSend` once,
  mid-sentence “发送” only edits the draft, and hidden/unmounted controls cancel.
- [ ] Implement the client/controller and composer controls with application
  shortcut `Ctrl/Cmd+Shift+D`; use Escape for emergency cancel while active.
- [ ] Verify Web tests and `npm run build --workspace web`.

### Task 6: TUI composer integration

**Files:**
- Modify: `tui/src/index.mjs`
- Test: `tui/test/dictation.test.mjs`
- Modify: `tui/test/index.test.mjs`

**Interfaces:**
- The persistent renderer exposes the same snapshot/apply/submit adapter as
  Web without persisting draft content.
- `Ctrl-D` toggles start/pause/resume and `Escape` cancels an active session;
  the footer always displays the binding when capability is available.

- [ ] Write failing renderer/controller tests for insertion at the terminal
  cursor, revision conflicts, visible state text, one submit, and disabled
  shortcut no-op.
- [ ] Route microphone chunks to `dictation.audio.append` only while dictation
  is listening/transcribing/editing; otherwise retain `audio.append`.
- [ ] Implement event handling and keyboard controls using the shared client.
- [ ] Run the TUI suite and confirm existing voice/input tests still pass.

### Task 7: Contract, privacy, and release verification

**Files:**
- Modify: `docs/contract.md`
- Modify: `docs/contract.zh.md`
- Modify: `PRIVACY.md`
- Modify: `docs/configuration.md`
- Modify: `docs/configuration.zh.md`

**Interfaces:**
- Documents name every advertised capability/event, default-off flag, no-disk
  boundary, provider-only failure behavior, and live-session delivery limit.

- [ ] Update English and Chinese contract tables and realtime event schemas.
- [ ] Update privacy/configuration text without promising P1/P2/P3 behavior.
- [ ] Run focused dictation tests, `npm test`, `npm run lint`, and `npm run
  build`; inspect complete exit codes and failure counts.
- [ ] Scan tracked changes for credentials and transcript logging with `git
  diff --check`, `git diff`, and targeted `rg` patterns.
- [ ] Commit, push the Multica-managed branch, and open a PR whose title or
  branch contains `ZQ-77` and whose body says `Related #165` without close
  intent.
