# Desktop native input testing

This document separates automated native-input evidence from installed-app
claims. The feature is part of Qwen Audio Agent Desktop, but its InputMethodKit
bundle changes macOS input-source state when installed. Do not perform the
manual matrix without explicit authorization from the machine owner.

## Current status

- Phase 0 automated substrate: implemented and locally verified.
- User-level installation, registration, and source selection: not run.
- Cross-application InputMethodKit interaction: not run.
- Physical-microphone and TCC interaction: not run.
- Optional Accessibility-based Voice Send: not implemented or authorized.
- Developer ID signing, notarization, and release Gatekeeper: not run.

The automated result does not mean system-wide dictation is ready for users.
Production IME-to-Bridge operation routing, the Desktop installer/settings
lifecycle, Gateway audio routing, and the installed-app matrix remain later
gates.

## Automated Phase 0 gate

Run on macOS from the repository root:

```sh
npm run native-input:test
node --test desktop/test/native-input-*.test.mjs
npm test
npm run lint
npm run build
npm run test:desktop-smoke
git diff --check
```

The native tests cover:

- protocol version, sequence, generation, target, replay, and 64 KiB limits;
- UTF-16 owned marked/final ranges, including emoji and composed characters;
- deterministic replace/delete limited to the latest session-owned final;
- Secure Event Input and visible-status fail-closed decisions;
- InputMethodKit client calls and non-consumption of physical key events;
- exact peer identity, same-user checks, a 0700 runtime directory, and a 0600
  Unix-domain socket;
- previous input-source compare-and-set restoration;
- Desktop-owned Bridge startup, scrubbed environment, emergency stop, and
  bounded shutdown;
- a real built Bridge process handling fake partial/final/pause/resume/cancel,
  rejecting malformed frames, exiting on EOF, and leaving no runtime files.

The packaging gate additionally requires:

```sh
npm run native-input:build:release
lipo -archs dist/native-input/QwenInputBridge
lipo -archs "dist/native-input/Qwen Input.app/Contents/MacOS/Qwen Input"
codesign --verify --strict \
  -R='identifier "ai.qwenaudio.agent.inputbridge"' \
  dist/native-input/QwenInputBridge
codesign --verify --deep --strict \
  -R='identifier "ai.qwenaudio.agent.inputmethod"' \
  "dist/native-input/Qwen Input.app"
```

Both native artifacts must contain `arm64` and `x86_64`. Local builds are
ad-hoc signed and are only build/integrity evidence; they are not notarized
release evidence.

## Authorization boundary

Before manual testing, obtain explicit approval for all of the following:

1. Copy the version-matched bundle to `~/Library/Input Methods`.
2. Register it and ask the user to enable Qwen Input in System Settings.
3. Temporarily select the input source in test applications.
4. Launch the packaged Desktop app and request Microphone permission.
5. If Voice Send is being tested separately, request Accessibility permission.

The base dictation path must not request Accessibility, Input Monitoring, Full
Disk Access, or administrator credentials. Use only non-sensitive test phrases.

## Installed-app manual matrix

Every row remains **NOT RUN** until separately authorized. Record OS version,
CPU architecture, app version, Desktop/IME/Bridge versions, result, and cleanup
evidence for each execution.

| Area | Scenario and expected result | Status |
| --- | --- | --- |
| Install | User-level install rejects symlinks/wrong owner or signature; no admin prompt | NOT RUN |
| Enable | User explicitly enables Qwen Input; Desktop does not silently enable it | NOT RUN |
| TextEdit / Notes | Partial is marked; final is committed at the caret; physical typing is preserved | NOT RUN |
| Safari textarea | Partial/final/edit remain on one locked target | NOT RUN |
| Safari contenteditable | UTF-16 range and caret movement behave deterministically | NOT RUN |
| Safari password | Secure field blocks start and performs no write or capture | NOT RUN |
| Terminal | Ordinary prompt accepts text; keyboard input is never swallowed | NOT RUN |
| Terminal secure input | Secure Keyboard Entry blocks or stops the session immediately | NOT RUN |
| VS Code / Monaco | Marked/final behavior is compatible or fails visibly without misdirected text | NOT RUN |
| Mail / Messages | Existing draft and selection are preserved | NOT RUN |
| Unsupported control | Unknown/custom-drawn control fails closed | NOT RUN |
| Focus switch | Target generation changes; partial is removed and no text enters the new focus | NOT RUN |
| Keyboard/pointer interruption | Owned partial settles/removes deterministically and capture pauses | NOT RUN |
| Source change | External user source change is not overwritten during restore | NOT RUN |
| Bridge/Desktop crash | Capture stops, owned partial is removed, and no orphan process/socket remains | NOT RUN |
| Microphone denied/revoked | Visible failure, zero provider audio, conversation, or Memory side effect | NOT RUN |
| Network/provider failure | Returns to ordinary typing; never falls back to main Realtime | NOT RUN |
| Continuous/pause/cancel | Paused bytes remain zero; cancel leaves no uncommitted side effect | NOT RUN |
| Memory correction | Exact non-sensitive fact replacement only; metadata audit only | NOT RUN |
| Update/rollback | Active session drains, source restores, versions match, rollback remains usable | NOT RUN |
| Disable/uninstall | Source is disabled, bundle moved to Trash, runtime artifacts removed | NOT RUN |
| Orphan repair | Input method is inert without authenticated Desktop/Bridge and can be repaired | NOT RUN |
| Architectures | arm64 and x86_64/Rosetta behavior is verified | NOT RUN |

## Cleanup evidence

After an authorized run, verify that Qwen Input is no longer selected, the
previous input source is restored, the Bridge and Desktop test processes have
exited, no runtime socket remains, and any test installation/profile/audio has
been removed. Scan repositories, runtime directories, and test logs for
credential patterns without printing credential values.
