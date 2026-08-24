# Desktop-Integrated Native Input Design (ZQ-77)

## Status and decisions

This design extends the composer-dictation foundation in PR #175 into the
system-wide macOS input experience requested by upstream issue #165.

The following decisions are approved:

- Input is a built-in Qwen Audio Agent Desktop capability, not a separate
  user-facing product, application, account, settings surface, updater, or
  background agent.
- The primary text path is InputMethodKit. Accessibility is optional and used
  only when the user explicitly enables Voice Send.
- Native input requires macOS 13 or later. Other Desktop capabilities may keep
  their existing platform floor.
- The feature is disabled by default and adds no transcript history.

The implementation baseline is PR #175 head
`31f91a49b296c61a4f2a191bdd34af1ebe68ab89`. At design time upstream `main`
is `7b363f668932e85fafbd2a23b24d60caba7ce4d9`. The implementation plan must
reconcile the intervening Desktop settings and gateway-process changes before
native code is added.

## Relationship to Desktop

There is one product and one release unit: Qwen Audio Agent Desktop.

The signed Desktop bundle contains the Bridge executable and the version-matched
Qwen Input bundle as private resources. Desktop Settings is the only UI for
installing, enabling, configuring, diagnosing, updating, disabling, and
uninstalling native input. The input source has no Dock icon, menu-bar item,
login item, account flow, provider configuration, updater, analytics client, or
independent microphone permission.

macOS requires an enabled input method to live under an Input Methods directory.
Desktop therefore copies its embedded, signed Qwen Input bundle into
`~/Library/Input Methods` and registers it with Text Input Sources. This
technical copy does not create a second product: its version is locked to the
Desktop release, it is inert without an authenticated Bridge owned by the
running Desktop process, and Desktop manages its complete lifecycle.

The Bridge is never installed as a daemon or LaunchAgent. Electron main starts
it as a transient child process and owns its lifetime. It exits when Desktop
exits. If the input method remains loaded after Desktop disappears, it must
fail closed, remove only its own marked text, and allow Desktop's next launch to
restore or uninstall it.

## Goals

1. A single global shortcut starts and stops dictation in the current supported
   macOS text control.
2. Partial text is visibly marked at the caret; final text becomes ordinary
   committed text without reading or uploading surrounding document content.
3. Voice editing changes only ranges written by the current dictation session.
4. Focus, input-source, permission, secure-input, process, or protocol changes
   stop capture before any further write.
5. Existing Desktop microphone capture, Gateway ASR, conversation submission,
   and Memory services remain the only audio and model path.
6. Installation, settings, updates, diagnostics, and uninstall remain part of
   Qwen Audio Agent Desktop.
7. The installed and notarized Desktop app is validated with a physical
   microphone across representative native, browser, terminal, and Electron
   applications.

## Non-goals

- No Windows or Linux system-wide input in this phase.
- No transcript or episodic input-history store.
- No Input Monitoring or Full Disk Access permission.
- No mandatory Accessibility permission for dictation or editing.
- No always-running native service, LaunchAgent, or separate ASR connection.
- No reading arbitrary text around the caret or collecting other keyboard
  input.
- No promise to support a custom-drawn control that exposes neither standard
  InputMethodKit behavior nor observable secure-input semantics.
- No CGEvent fallback in the first release.

## Alternatives considered

### 1. Desktop-owned InputMethodKit plus transient Bridge — selected

Qwen Input performs marked/final text operations. A signed Bridge inside the
Desktop release coordinates Text Input Sources and authenticated local IPC. Desktop
continues to own microphone capture, Gateway connectivity, state, settings,
updates, and teardown.

This provides the strongest standard text-input semantics without making
Accessibility mandatory. It reuses the current ASR and Memory path and avoids a
second resident service. Its cost is a universal nested bundle, authenticated
native IPC, input-source switching, and careful update rollback.

### 2. InputMethodKit plus independent native background agent — rejected

An `SMAppService` or LaunchAgent could capture audio and connect to the Gateway
while the Desktop UI is closed. That duplicates capture, WebSocket,
authentication, state-machine, settings, logging, update, and uninstall logic.
It also creates a Background Item and may create a second microphone-consent
surface. The extra independence is not required by the approved product model.

### 3. Accessibility and CGEvent injection without an input method — rejected

This avoids input-source installation but makes Accessibility a prerequisite
for basic text entry. Marked text, selections, concurrent keyboard editing,
Terminal behavior, Electron controls, and secure-field exclusion become less
reliable. This may be considered later only for explicitly allowlisted
applications after separate security review.

## Architecture

```text
Global shortcut
    |
    v
Desktop renderer
  - microphone capture
  - Gateway WebSocket / dictation protocol
  - visible Desktop status and settings
    |
    | narrow Electron IPC
    v
Electron main
  - session orchestration and feature gate
  - Bridge lifecycle and emergency stop
  - update / shutdown coordination
    |
    | inherited private stdio
    v
QwenInputBridge (embedded Desktop executable)
  - install/status/uninstall plan
  - TIS select/restore
  - authenticated Unix-domain listener in a 0700 runtime directory
    |
    | framed local socket; same euid + exact dynamic code requirement
    v
Qwen Input (Desktop-managed InputMethodKit bundle)
  - active controller and target token
  - UTF-16 marked/final ranges
  - caret status panel and secure-input gate
    |
    v
Current supported target application
```

### Desktop renderer

The renderer keeps the existing `getUserMedia` path and the existing Gateway
socket. It routes microphone frames exclusively to either main Realtime or
dictation; a paused or blocked native session routes them to neither. It owns
the user-visible state, continuous-mode setting, pause/resume/cancel controls,
and optional Voice Send setting.

The native controller is separate from the Web composer controller because a
native session starts with an empty owned draft and must never request the
target application's surrounding text. Both controllers reuse the shared
dictation protocol and deterministic command rules.

### Electron main

Electron main owns the global shortcut, feature flag, permission state,
Bridge child process, session generation, emergency stop, and graceful
shutdown. Native-input shortcut handling is a separate controller from the
existing orb-presence shortcut.

Main exposes a narrow preload API. Renderer messages are limited to lifecycle,
audio-route state, provider results, and structured native operations. No
arbitrary native command or file path crosses preload.

### QwenInputBridge

The Bridge is a universal Swift executable embedded in Desktop. It never
captures audio, connects to the Gateway, holds provider credentials, or writes
user text. It validates and atomically installs the version-matched input
bundle, queries registration/enablement, validates that Qwen Input is already
user-selected for a session, publishes a transient Unix-domain socket, and
reports typed lifecycle events. Production does not silently select or restore
an input source.

Electron main communicates with the Bridge over inherited stdin/stdout. The
Bridge creates `control.sock` under a Desktop-owned 0700 runtime directory and
sets the socket mode to 0600. The path is a locator, not an authentication
secret. Phase 0 proved that `NSXPCListenerEndpoint` cannot be archived with
`NSKeyedArchiver` (`encodeWithCoder:` requires `NSXPCCoder`), so a file-backed
anonymous-XPC rendezvous is not a valid implementation. Both socket peers use
`getpeereid`/`LOCAL_PEERPID` plus Security.framework dynamic-code validation;
PID alone is never accepted as identity.

### Qwen Input

Qwen Input is a palette-style InputMethodKit bundle without a user-facing app.
It manages one ledger per active `IMKInputController`. It accepts only
authenticated operations for the currently locked target and writes only text
created by that native dictation session.

Partial text uses `setMarkedText`; final text uses `insertText` to replace the
owned marked range. All ranges are UTF-16. The input method does not query or
upload surrounding document text. Physical typing and pointer changes settle
or remove the owned partial before the session pauses.

The native spike is a release gate for palette behavior: Qwen Input must not
swallow physical keys when idle, and target applications must retain ordinary
typing before, during, and after source restoration. Failure rejects this
architecture before Gateway integration.

## Session and target model

The native state machine is:

```text
disabled -> ready -> arming -> starting -> listening <-> transcribing
                                      \-> paused
listening/transcribing -> ready-to-send -> listening or idle
any active state -> blocked | cancelled | error
```

The global shortcut performs these steps in order:

1. Verify the feature is enabled, Desktop owns microphone input, no external
   input suspension is active, and Secure Event Input is off.
2. Require Qwen Input to be selected explicitly in the macOS input menu. If a
   different source is active, fail visibly without changing it.
3. Wait for an active controller, a visible caret or Desktop status, and a
   stable target token `{sessionUUID, generation, controllerUUID,
   uniqueClientID}`.
4. Only then transfer microphone routing from main Realtime to dictation and
   start the existing Gateway ASR session.

Before every partial, final, edit, commit, or Voice Send operation, Qwen Input
revalidates the target token, active controller, generation, input source, and
Secure Event Input. A mismatch removes only the current owned marked partial,
stops local capture immediately, and cancels pending Gateway work without
changing the user's input source. Already committed text is never rolled back
and no text is written to the new focus.

On macOS 26.5.1, `TISSelectInputSource` alone did not activate an
InputMethodKit controller. The first-release contract therefore follows the
standard input-method model: Qwen Input stays selected while native dictation
is in use, and physical keyboard events pass through. If the user explicitly
switches to another input source while marked text is active, macOS settles
that composition in the old target; Qwen rejects subsequent native operations
and never overwrites or writes into the newly selected source.

Keyboard or pointer intervention settles or removes the owned partial and
pauses the session. The first release does not guess when to resume after a
focus change; the user must explicitly resume or trigger a new session.

## Editing, submission, and Memory

The native ledger records only ranges and text produced by the current session.
Replace/delete operations require one exact match inside the latest owned final
range and an unchanged target generation. Unknown, overlapping, ambiguous, or
stale ranges fail visibly and preserve the dictated command as ordinary text;
they never fall back to whole-document search.

`send`, `发送`, `submit`, and `提交` are terminal commands only as standalone
final segments or after an explicit sentence boundary. The command itself is
removed from inserted text.

Basic dictation does not synthesize Return. With Voice Send disabled or
unavailable, the UI prompts the user to press Return. If the user explicitly
enables Voice Send and grants Accessibility, Desktop verifies the same focused,
enabled, editable, non-secure element and requests one `kAXConfirmAction`.
Focus changes, missing AX support, revoked permission, or secure state fail
closed. There is no CGEvent fallback.

Commit IDs are deduplicated for the live session. Conversation submission or a
Memory-only correction is acknowledged only after the native text operation
succeeds against the locked target. Explicit durable-fact correction reuses the
existing sensitive filter, exact replace service, and metadata-only audit.
Partial, cancelled, failed, or focus-lost input never reaches conversation,
Memory, extraction, or audit.

## IPC security

IME and Bridge mutually require the expected Team ID and exact bundle
identifiers, the same effective user, and a valid code signature. Each side
reads the connected Unix peer's effective user and PID, resolves its live
`SecCode`, and checks an exact compiled signing requirement. Each message carries
`protocolVersion`, `sessionID`, `generation`, `targetID`, `operationID`, and a
monotonic sequence number. Both peers enforce payload-size limits and a replay
LRU.

The IME never connects directly to the loopback Gateway. Existing Gateway
origin classification is not treated as native process authentication.

Unsigned peers, wrong team/bundle/user, unsupported protocol versions,
replayed or out-of-order messages, oversized payloads, replaced socket paths,
and stale target generations are rejected without text or capture
side effects.

## Secure input and permissions

`IsSecureEventInputEnabled()` is checked before session start and every write.
If it becomes active, the system removes the current owned marked partial,
stops microphone routing and Gateway work, preserves prior committed text,
restores the previous input source, and performs no send or Memory action.

With optional Accessibility enabled, secure-text subrole and focused/enabled/
editable/pid checks provide an additional Voice Send gate. The release promise
covers standard controls that follow macOS secure-input semantics. A custom
control that exposes neither Secure Event Input nor secure Accessibility
semantics is unsupported; any observable unknown or API error still fails
closed.

The permission budget is:

- Microphone: existing Desktop permission, required for dictation.
- Input source enablement: one explicit user action in System Settings.
- Accessibility: optional, requested only from the Voice Send setting.
- Input Monitoring and Full Disk Access: never requested.

## Installation, update, and uninstall

### Installation

Desktop Settings presents one feature, "Input anywhere". Enabling it verifies
the embedded bundle's hash, Team ID, bundle ID, version, ownership, and path;
rejects symlinks and non-current-user targets; stages under the user account;
atomically installs to `~/Library/Input Methods`; and registers the source.
Desktop then guides the user to enable Qwen Input in System Settings and select
it from the macOS input menu. It never silently enables or selects the source
and never asks for administrator credentials.

### Update

Desktop and Qwen Input versions must match. Before replacement, Desktop ends
the active session, drains and stops the Bridge, validates the new nested
bundle, then atomically replaces and
re-registers it. One last-known-good bundle is retained until the new protocol
handshake succeeds. A loaded old IME is not killed; new sessions remain blocked
with restart/disable-enable guidance until the matching version is active.

### Uninstall and orphan handling

Disabling or uninstalling from Desktop stops capture, disables/unregisters the
user-selected Qwen Input, moves its bundle to Trash, and
removes the runtime socket, manifest, and native-input cache. Existing Gateway
configuration and Memory are retained unless the user separately deletes
them. TCC records remain under System Settings control.

If Desktop is manually deleted first, the orphaned input method cannot
authenticate a Bridge and therefore cannot capture, connect, or insert text.
On activation it shows inert recovery guidance. Reinstalling Desktop can repair
or remove the matching orphan.

## Failure behavior

The following conditions synchronously stop local microphone routing, cancel
pending native/Gateway work, remove only the owned marked partial when it is
still under IME ownership, and leave the user's input source unchanged:

- target or focus generation changes;
- Secure Event Input starts;
- microphone permission is denied or revoked;
- Qwen Input is disabled or its version mismatches Desktop;
- Bridge, renderer, Gateway, or provider disconnects;
- native peer authentication or sequence validation fails;
- global shortcut registration conflicts;
- no approved status surface is visible;
- emergency stop is invoked.

AX revocation disables only Voice Send. It does not disable basic dictation.
Network or provider failures return the user to ordinary keyboard input and
never fall back to main Realtime ASR.

## Protocol and configuration

The feature remains off unless the existing dictation feature is enabled and a
new Desktop native-input setting is enabled. Gateway advertises a distinct
native-input capability only when both the protocol and Desktop-native path are
available. Additive public wire changes use protocol 2.2; existing 2.1 Web/TUI
clients continue to use capabilities rather than version comparisons.

Desktop owns the global shortcut, continuous-mode, pause/resume, Voice Send,
install state, diagnostics, and ASR configuration UI. There is no input-method
preferences window. Credentials remain in the existing Desktop/Gateway
configuration and are never copied into native files or IPC messages.

## Code surface

- Add `desktop/native/QwenInput.xcodeproj` with IME and Bridge targets plus
  Swift unit/integration tests.
- Add focused Desktop modules for native host, typed protocol, shortcut,
  installer, and lifecycle coordination; integrate them with main, preload,
  settings, updater, and graceful shutdown.
- Add a Desktop-native dictation controller before the Desktop renderer's
  audio-only early return. Reuse microphone and Gateway hooks without exposing
  a full composer or reading target content.
- Extend shared dictation commands and Gateway correlation for native target
  operations, pause/resume, `submit`/`提交`, and native capability advertising.
- Package universal IME and Bridge artifacts as nested signed Desktop
  resources and include them in Developer ID signing, hardened runtime,
  notarization, update, and uninstall verification.
- Update Desktop, configuration, contract, privacy, and installation docs in
  English and Chinese.

## Delivery sequence and gates

Product packaging is unified even when code review is staged. PR #175 remains
the reusable composer/Gateway foundation. It must not be merged with close
intent for ZQ-77 before the native phases are accepted. Native work may use
stacked review branches to keep Swift security, Gateway integration, and
release packaging independently reviewable; every shipped artifact still
lands in the same Desktop release.

## Phase 0 observed evidence (2026-08-22)

The implementation was reconciled on upstream `main` at
`7b363f668932e85fafbd2a23b24d60caba7ce4d9`. The automated native substrate
gate now passes on macOS arm64:

- Swift core and adapter tests cover protocol/replay rules, UTF-16 owned text,
  secure and visibility gates, InputMethodKit calls, signed peer validation,
  secure runtime paths, and input-source restoration policy.
- A real ad-hoc-signed Bridge and deliberately wrong-identifier peer prove the
  exact local peer boundary. A separate real Bridge process gate covers ready,
  fake partial/final/pause/resume/cancel, malformed input, control-pipe EOF,
  clean shutdown, and zero runtime-file residue.
- Electron main owns one transient Bridge child with a credential-free
  environment, default-off feature/shortcut, renderer-loss emergency stop, and
  native-before-Gateway shutdown ordering.
- The local Desktop DMG contains strict-verifiable Bridge and InputMethodKit
  identities. The release native build contains both `arm64` and `x86_64`.

The next automated stage adds the Desktop install/status/repair/uninstall
lifecycle, correlated renderer/Gateway/native operations, and a real signed
IME→Bridge fake-operation process probe. It remains an automated result, not an
installed cross-application claim. No input method has been copied, registered,
enabled, or selected and no TCC permission has been requested. Physical
microphone/target-app interaction, optional Voice Send, Developer ID
signing/notarization, and the manual app matrix remain open. The executable
matrix and authorization boundary are recorded in
`docs/desktop/native-input-testing.md` and
`docs/desktop/native-input-testing.zh.md`.

### Phase 0: native feasibility spike

With the feature off and fake transcript input, prove:

- marked/final insertion and UTF-16 range behavior;
- physical typing is never swallowed while idle or paused;
- previous input-source selection is restored;
- secure standard controls and Secure Event Input fail closed;
- signed local IPC accepts only the intended peers and rejects wrong/unsigned peers;
- the caret or Desktop status is visible before capture can start;
- Bridge crash and Desktop exit remove partial state without committed-text
  rollback.

Any failed invariant rejects the selected architecture before Gateway or real
microphone integration.

### Phase 1: Desktop lifecycle

Implement user-level install/status/repair/uninstall, global shortcut conflict
handling, source restore, target generation, replay protection, settings,
update drain/rollback, orphan recovery, and automated symlink/path/ownership/
signature tests.

### Phase 2: Gateway, microphone, and Memory

Integrate the existing dictation provider and add native operation/result
correlation. Test fake provider first, then a physical microphone. Verify
partial/final/edit, continuous on/off, pause/resume with zero paused audio,
focus-change cancellation, live-session exactly-once, sensitive Memory
filtering, and zero transcript/audio/target-text persistence.

### Phase 3: optional Voice Send

Only after explicit Accessibility consent, verify same-focus single confirm,
sentence-boundary command parsing, manual-Return fallback, permission revocation,
secure controls, and focus-change rejection.

### Phase 4: release and installed-app E2E

Run Swift tests and the repository test/lint/build suite. Produce a universal
`arm64` + `x86_64` Desktop DMG with nested strict code-sign verification,
hardened runtime, Developer ID signing, notarization/staple, DMG verification,
and secret/log scans. Release artifacts must not contain `get-task-allow`,
disabled library validation, Input Monitoring, or Full Disk Access entitlement.

Installed-app physical-microphone E2E covers TextEdit/Notes, Safari textarea/
contenteditable/password, Terminal with Secure Keyboard Entry, VS Code/Electron,
Mail/Messages, and one unsupported custom-drawn fixture. It covers partial,
final, edit, continuous, pause, cancel, keyboard/pointer interruption, focus
switch, emergency stop, permission revocation, IME disable, Bridge/Gateway
crash, network failure, active-session update, rollback, uninstall/reinstall,
and orphan repair on both arm64 and x86_64 at the minimum and current supported
macOS versions.

ZQ-77 is not complete until these installed Desktop and cross-application gates
pass. PR #175's Web/TUI/Gateway tests alone are not completion evidence.

## Rollback

Turning off the Desktop native-input setting stops new sessions and hides the
shortcut while leaving existing Web/TUI dictation behavior unchanged. Desktop
can unregister and remove Qwen Input without migrating conversation or Memory
data because this phase adds no persistent transcript schema. A release can
roll back to the last-known-good embedded native bundle only after restoring
the prior input source and ending active capture.
