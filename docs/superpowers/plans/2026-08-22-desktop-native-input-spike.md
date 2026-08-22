# Desktop Native Input Phase 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prove that Qwen Audio Agent Desktop can own a macOS InputMethodKit input source and transient Bridge that safely render marked/final text, restore the previous input source, reject secure/stale operations, and clean up on process exit before any Gateway, microphone, or provider integration is attempted.

**Architecture:** The Desktop app embeds two universal native artifacts: a palette-style `Qwen Input.app` and a transient `QwenInputBridge` executable. A shared Swift core defines the typed protocol, session ledger, secure-input gate, and client-independent text operation engine. Electron main owns the Bridge process through framed stdin/stdout and a default-off feature gate. The Phase 0 harness uses fake transcript operations only; the input method never connects to the Gateway, captures audio, requests Accessibility, or persists user text.

**Tech Stack:** Swift 6, AppKit, InputMethodKit, Carbon/HIToolbox, Foundation/NSXPCConnection, XCTest, XcodeGen/Xcode 26, Node.js ESM, `node:test`, Electron Builder.

**Spec:** `docs/superpowers/specs/2026-08-22-desktop-native-input-design.md`

**Global Constraints:** Native input requires macOS 13+. The feature remains disabled by default. No provider credentials, network access, microphone/TCC prompt, Accessibility, Input Monitoring, Full Disk Access, transcript history, LaunchAgent, daemon, or system-level installation is permitted in Phase 0. Automated tests may build and inspect artifacts but may not copy to `~/Library/Input Methods` or change the active input source. The final manual IMK matrix is a separate, explicitly approved gate.

---

### Task 1: Reconcile the current upstream Desktop baseline

**Files:** Existing PR branch only; resolve changes in `desktop/src/gateway-process.mjs`, `desktop/src/settings-config.mjs`, `desktop/src/settings.js`, and their tests if the upstream merge touches them.

1. Fetch `origin/main` and record the exact upstream SHA in the implementation report.
2. Run `git merge --no-edit origin/main`; resolve only semantic overlaps, preserving both upstream Pi/backend changes and the existing composer-dictation capability.
3. Run the pre-native baseline:

   ```bash
   npm test
   npm run lint
   npm run build
   git diff --check
   ```

4. Stop if the baseline is not green; diagnose and repair the integration before adding native files.
5. Commit the merge separately so every later native regression can be bisected against the reconciled baseline.

### Task 2: Scaffold a reproducible macOS native workspace

**Files:** Create `desktop/native/project.yml`, `desktop/native/QwenInput.xcodeproj/**`, `desktop/native/Sources/QwenInputCore/**`, `desktop/native/Sources/QwenInputBridge/main.swift`, `desktop/native/Sources/QwenInput/main.swift`, `desktop/native/Resources/QwenInput-Info.plist`, `desktop/native/Tests/QwenInputCoreTests/**`, `scripts/build-native-input.mjs`, `desktop/test/native-input-build.test.mjs`; modify `.gitignore`, `package.json`.

1. Write a failing Node test that asserts:
   - `npm run native-input:build` exists;
   - the canonical XcodeGen file declares `QwenInputCore`, `QwenInputBridge`, `Qwen Input`, and `QwenInputCoreTests` targets;
   - every native target has `MACOSX_DEPLOYMENT_TARGET: 13.0`;
   - the input method bundle ID is `ai.qwenaudio.agent.inputmethod` and the Bridge bundle ID is `ai.qwenaudio.agent.inputbridge`;
   - no target declares microphone, Accessibility, Input Monitoring, network-client, or Full Disk Access entitlements.
2. Run `node --test desktop/test/native-input-build.test.mjs` and confirm it fails because the native workspace does not exist.
3. Add an XcodeGen project with a framework/core target, command-line Bridge target, InputMethodKit application target, and XCTest target. Set Swift 6 strict concurrency, universal release architectures (`arm64 x86_64`), and macOS 13 deployment.
4. Implement `scripts/build-native-input.mjs` as a narrow `xcodegen generate` plus `xcodebuild` launcher. It must accept only `--configuration Debug|Release`, `--arch current|universal`, and `--output <path>`; resolve output under the repository or an explicit temporary directory; never install or activate the input source.
5. Add `native-input:generate`, `native-input:test`, and `native-input:build` package scripts.
6. Generate and commit `QwenInput.xcodeproj`, run the focused Node test, then run `npm run native-input:test` and confirm the empty native targets compile.
7. Commit the reproducible scaffold.

### Task 3: Lock the native protocol and replay rules

**Files:** Create `desktop/native/Sources/QwenInputCore/IPCProtocol.swift`, `desktop/native/Sources/QwenInputCore/ProtocolValidator.swift`, `desktop/native/Tests/QwenInputCoreTests/ProtocolValidatorTests.swift`.

1. Write failing XCTest cases for the exact envelope:

   ```swift
   struct NativeInputEnvelope<Payload: Codable & Sendable>: Codable, Sendable {
       let protocolVersion: UInt16
       let sessionID: UUID
       let generation: UInt64
       let targetID: UUID
       let operationID: UUID
       let sequence: UInt64
       let payload: Payload
   }
   ```

   Require protocol version `1`, monotonically increasing `sequence`, current `sessionID/generation/targetID`, unique `operationID`, and a maximum encoded frame of 64 KiB.
2. Add red tests for wrong version, stale generation, wrong target, replayed operation, duplicate/out-of-order sequence, oversized frame, and a valid sequence after a new generation.
3. Implement `ProtocolValidator.accept(metadata:encodedByteCount:) -> ValidationResult` and a bounded 256-entry operation replay LRU. Rejection must be typed and must not advance accepted state.
4. Run `npm run native-input:test`; confirm every protocol test passes.
5. Commit the protocol core.

### Task 4: Implement the owned-text session ledger

**Files:** Create `desktop/native/Sources/QwenInputCore/SessionLedger.swift`, `desktop/native/Sources/QwenInputCore/TextOperation.swift`, `desktop/native/Tests/QwenInputCoreTests/SessionLedgerTests.swift`.

1. Write failing tests for:
   - UTF-16 ranges containing emoji and composed characters;
   - `partial(text:)` replacing only the current owned marked range;
   - `final(text:)` committing and advancing the latest owned-final range;
   - replace/delete succeeding only for one exact match inside the latest owned final;
   - ambiguous, absent, overlapping, stale-generation, and `NSNotFound` ranges failing without a mutation;
   - focus/target generation changes invalidating all pending operations;
   - cancel removing only the owned partial and never rolling back committed text.
2. Model output as data, not direct AppKit calls:

   ```swift
   enum ClientTextEffect: Equatable, Sendable {
       case setMarked(text: String, selection: NSRange, replacement: NSRange)
       case insert(text: String, replacement: NSRange)
       case removeMarked(replacement: NSRange)
       case none
   }
   ```

3. Implement `SessionLedger` with one active target token and only session-owned text/ranges. Do not add a method that reads surrounding document content.
4. Run the native suite and commit the ledger.

### Task 5: Add secure-input and visibility fail-closed gates

**Files:** Create `desktop/native/Sources/QwenInputCore/NativeSessionState.swift`, `desktop/native/Sources/QwenInputCore/SafetyGate.swift`, `desktop/native/Sources/QwenInput/SecureInputGate.swift`, `desktop/native/Tests/QwenInputCoreTests/SafetyGateTests.swift`.

1. Write failing table-driven tests for `disabled`, `ready`, `arming`, `starting`, `listening`, `transcribing`, `paused`, `blocked`, `cancelled`, and `error`.
2. Require all of `featureEnabled`, `desktopConnected`, `targetLocked`, `statusVisible`, `inputSourceActive`, and `secureEventInput == false` before returning `mayCapture=true` or any non-`none` text effect.
3. Require secure-input activation, unknown status, target mismatch, hidden status, Bridge loss, or Desktop exit to synchronously return `stopAndRemovePartial`.
4. Implement the production secure-input adapter as the only call site of Carbon `IsSecureEventInputEnabled()`. Inject a closure into the core gate so XCTest never toggles system Secure Event Input.
5. Run the native suite and commit the safety state machine.

### Task 6: Adapt the ledger to InputMethodKit without swallowing keys

**Files:** Create `desktop/native/Sources/QwenInput/InputController.swift`, `desktop/native/Sources/QwenInput/TextClientAdapter.swift`, `desktop/native/Sources/QwenInput/ControllerRegistry.swift`, `desktop/native/Tests/QwenInputCoreTests/TextClientAdapterTests.swift`; modify `desktop/native/Sources/QwenInput/main.swift`, `desktop/native/Resources/QwenInput-Info.plist`.

1. Define a testable client seam exposing only:

   ```swift
   protocol NativeTextClient: AnyObject {
       var selectedRange: NSRange { get }
       var markedRange: NSRange { get }
       func setMarkedText(_ text: NSAttributedString,
                          selectionRange: NSRange,
                          replacementRange: NSRange)
       func insertText(_ text: Any, replacementRange: NSRange)
   }
   ```

2. Write failing fake-client tests proving partial/final/remove effects call the exact IMK methods and ranges, unknown ranges block, and idle/paused `handle(_:client:)` always returns `false` so physical key events continue to the target application.
3. Implement `QwenInputController: IMKInputController` as a thin adapter around `SessionLedger` and `SafetyGate`; register/unregister the current controller with a generation-changing `ControllerRegistry` on activation/deactivation/close.
4. Create one `IMKServer` in `main.swift` from `InputMethodConnectionName`, then run the app event loop. The palette input method must have no Dock/menu/login UI.
5. Add the required InputMethodKit plist keys and no privacy/TCC usage strings beyond what the parent Desktop already owns.
6. Run `npm run native-input:test` and a Debug native build; inspect the built plist with `plutil` and commit.

### Task 7: Add a framed Desktop-to-Bridge control channel

**Files:** Create `desktop/native/Sources/QwenInputCore/FrameCodec.swift`, `desktop/native/Sources/QwenInputBridge/BridgeRuntime.swift`, `desktop/native/Tests/QwenInputCoreTests/FrameCodecTests.swift`, `desktop/src/native-input-protocol.mjs`, `desktop/test/native-input-protocol.test.mjs`.

1. Write Swift and Node conformance fixtures for a 4-byte big-endian length plus UTF-8 JSON frame. Reject zero length, more than 64 KiB, truncated payloads, invalid UTF-8/JSON, unknown message types, and trailing bytes.
2. Define only these Phase 0 message types: `bridge.ready`, `session.arm`, `session.partial`, `session.final`, `session.cancel`, `session.pause`, `session.resume`, `session.state`, `bridge.stop`, and `bridge.error`.
3. Implement an async Bridge runtime that reads stdin, validates every envelope, writes one framed response per accepted request, and exits on EOF or `bridge.stop`. It must not create sockets, read environment credentials, or write files.
4. Implement the matching Node encoder/decoder with the same fixtures and an incremental stream parser.
5. Run both test suites and commit the framed protocol.

### Task 8: Authenticate the IME/Bridge XPC boundary

**Files:** Create `desktop/native/Sources/QwenInputCore/PeerRequirement.swift`, `desktop/native/Sources/QwenInputBridge/XPCService.swift`, `desktop/native/Sources/QwenInput/XPCClient.swift`, `desktop/native/Tests/QwenInputCoreTests/PeerRequirementTests.swift`, `desktop/native/Tests/QwenInputCoreTests/XPCIntegrationTests.swift`.

1. Write failing policy tests that accept only:
   - Bridge bundle `ai.qwenaudio.agent.inputbridge` when called by IME bundle `ai.qwenaudio.agent.inputmethod`;
   - the configured Team ID in release fixtures or an explicit ad-hoc test requirement in Debug;
   - the current effective user;
   - protocol version `1`.
2. Add rejection cases for wrong bundle, wrong team, wrong euid, unsigned/non-test peers, stale endpoint generation, replay, and oversized messages.
3. Implement an anonymous `NSXPCListener`, narrow `@objc` protocol methods with `Data` payloads, and `NSXPCConnection.setCodeSigningRequirement` on macOS 13+. Keep manual audit-token/`SecCode` fallback out of scope.
4. Publish the archived listener endpoint only through a Bridge-owned runtime directory verified as `0700` and endpoint file `0600`; reject symlinks and wrong ownership. The file contains no user text.
5. Build ad-hoc-signed Debug fixtures and run the integration test with one accepted and one deliberately wrong-bundle peer.
6. Commit only after both unit and process-level integration tests pass.

### Task 9: Implement testable input-source selection and restoration

**Files:** Create `desktop/native/Sources/QwenInputBridge/InputSourceCoordinator.swift`, `desktop/native/Tests/QwenInputCoreTests/InputSourceCoordinatorTests.swift`.

1. Abstract TIS calls behind `InputSourceAPI` with `currentKeyboardSource`, `find(id:)`, `register(url:)`, `select(_:)`, and `isEnabled(_:)`.
2. Write failing fake-API tests for: record-before-select, successful restore, select failure, Qwen Input disabled, target/source changed externally, repeated stop idempotency, Bridge crash recovery instruction, and never restoring an unverified source.
3. Implement the production adapter with `TISCopyCurrentKeyboardInputSource`, `TISCreateInputSourceList`, `TISRegisterInputSource`, and `TISSelectInputSource`. Phase 0 status may report registration state but must not install, enable, or select a real source in automated tests.
4. Run the native suite and commit.

### Task 10: Make the Bridge a Desktop-owned transient child

**Files:** Create `desktop/src/native-input-host.mjs`, `desktop/src/native-input-feature.mjs`, `desktop/test/native-input-host.test.mjs`, `desktop/test/native-input-feature.test.mjs`; modify `desktop/src/main.mjs`, `desktop/src/graceful-shutdown.mjs`, `desktop/src/preload.cjs` only as required for the default-off lifecycle.

1. Write failing Node tests proving:
   - default settings do not spawn the Bridge or register a native-input shortcut;
   - enable starts exactly one child with `stdio: ['pipe','pipe','pipe']`, no shell, a fixed embedded executable path, and an allowlisted environment without provider keys;
   - start waits for `bridge.ready` before reporting `ready`;
   - malformed output, timeout, child exit, Desktop shutdown, or renderer loss invokes local emergency stop and rejects further operations;
   - stop sends `bridge.stop`, waits with a bounded timeout, then terminates only the owned child;
   - no detached process, LaunchAgent, daemon, or persisted transcript is created.
2. Implement `NativeInputHost` with injected `spawn`, clock, and artifact resolver. Keep all IPC methods typed through `native-input-protocol.mjs`.
3. Add `NativeInputFeature` as a separate lifecycle/shortcut owner; do not extend `DesktopPresence` beyond its orb responsibility.
4. Wire shutdown ordering as `native emergency stop -> Bridge drain/exit -> Gateway/renderer shutdown -> logger flush`.
5. Expose only status/start/stop/fake-partial/fake-final methods in a development-only preload surface guarded by the disabled-by-default setting. Do not expose paths or arbitrary commands.
6. Run the focused Desktop tests and commit.

### Task 11: Package and inspect the embedded native artifacts

**Files:** Modify `scripts/build-native-input.mjs`, `desktop/electron-builder.yml`, `package.json`, `desktop/test/native-input-build.test.mjs`, `desktop/test/release-artifacts.test.mjs`; create `desktop/native/README.md`.

1. Extend failing release-artifact tests to require the Bridge and Qwen Input resources in the Desktop bundle and verify the parent build runs the native build first on macOS only.
2. Build current-architecture Debug artifacts into `dist/native-input`, then package a local ad-hoc Desktop DMG.
3. Verify without installing:

   ```bash
   codesign --verify --deep --strict "dist/native-input/Qwen Input.app"
   codesign --verify --strict "dist/native-input/QwenInputBridge"
   plutil -lint "dist/native-input/Qwen Input.app/Contents/Info.plist"
   hdiutil verify "dist/desktop/qwen-audio-agent-*-mac-*.dmg"
   ```

4. Inspect both binaries with `otool -L`, `codesign -d --entitlements :-`, and `strings`. Assert no provider key names, Gateway secret names, microphone usage string, network entitlement, Accessibility prompt, LaunchAgent, or daemon identifier appears in either artifact.
5. Document that Phase 0 artifacts are ad-hoc/local only and are not a signed/notarized release claim.
6. Run the focused build/release tests and commit packaging changes.

### Task 12: Run the automated Phase 0 gate and prepare the manual matrix

**Files:** Create `desktop/native/Tests/Fixtures/**` only for non-sensitive fake text; modify `docs/superpowers/specs/2026-08-22-desktop-native-input-design.md` with observed results; create `docs/desktop/native-input-testing.md` and `docs/desktop/native-input-testing.zh.md`.

1. Use only generated strings such as `hello`, `你好`, `A😀B`, and `é` in fixtures. Run:

   ```bash
   npm run native-input:test
   node --test desktop/test/native-input-*.test.mjs
   npm test
   npm run lint
   npm run build
   npm run test:desktop-smoke
   git diff --check
   ```

2. Run an isolated Bridge process test from the built binary: ready handshake, fake partial/final, cancel, replay rejection, secure-state rejection, malformed frame rejection, EOF cleanup, and zero residual child processes.
3. Snapshot the repository and isolated runtime directory before/after; assert no audio, transcript, draft, endpoint, credential, LaunchAgent, or cache files remain.
4. Write the manual matrix for TextEdit/Notes, Safari textarea/contenteditable/password, Terminal Secure Keyboard Entry, VS Code/Monaco, Mail/Messages, focus switching, physical typing, caret visibility, Bridge crash, Desktop exit, source restore, install/disable/uninstall, and arm64/x86_64. Clearly mark every row `not run` until separately authorized.
5. Stop before copying to `~/Library/Input Methods`, registering/selecting a real input source, opening System Settings, launching target apps, or requesting any TCC permission. Ask for explicit approval for that reversible system-state test.
6. Record the exact upstream/base/head SHAs and automated results, then request an independent cross-model review of the Phase 0 code before manual installation.

