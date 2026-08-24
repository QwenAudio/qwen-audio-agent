# Desktop native input

This directory contains the macOS native-input components embedded in Qwen
Audio Agent Desktop:

- `Qwen Input.app` is a palette-style InputMethodKit input source.
- `QwenInputBridge` is a transient child process owned by Electron main.
- `QwenInputCore` contains protocol, safety, text-ledger, peer-authentication,
  and input-source restoration logic shared by both native targets.

The native components do not capture audio, connect to the Gateway, hold model
credentials, or persist dictated text. Desktop remains the only product,
settings surface, microphone owner, network client, updater, and lifecycle
owner. The Bridge is not a daemon or LaunchAgent.

## Local build

```sh
npm run native-input:test
npm run native-input:build
```

The default build is current-architecture, ad-hoc signed, and written under
`dist/native-input`. It is for local inspection only. It is not installed,
registered, enabled, or selected by the build or test scripts. A formal release
build uses `native-input:build:release` to create universal artifacts before
Electron Builder signs and notarizes the complete Desktop app.

## Phase 0 boundary

Native input is disabled by default. The current automated phase validates the
artifacts, protocol, owned-text ranges, Secure Event Input gate, authenticated
local peer, input-source recovery policy, and Desktop-owned Bridge lifecycle.
It deliberately does not copy anything to `~/Library/Input Methods`, change the
active input source, request microphone or Accessibility permissions, or claim
that cross-application interaction has passed. Those actions belong to the
separately approved manual macOS matrix.
