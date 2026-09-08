# Mobile

Mobile is a native presentation of WebUI. The Gateway and Backend Agent keep
running on your computer; the phone owns the microphone, speaker, text/image
input, and UI. It uses the same Gateway Client Protocol as Desktop, WebUI, and
TUI, without importing Realtime Provider or backend-protocol internals.

> iOS and Android development builds are available. App-store distribution is
> not available yet.

## Get Development Builds

Open [GitHub Actions → Mobile](https://github.com/QwenAudio/qwen-audio-agent/actions/workflows/mobile.yml?query=branch%3Amain),
choose a successful `main` build, and download `mobile-android-debug-apk` under Artifacts.
Unzip it, transfer the APK to an Android phone, and install it; allow this installation source if prompted.
Actions downloads generally require signing in to GitHub. Expired artifacts require a new build
or the source-build steps below.

`mobile-ios-simulator-app` is for the **iOS Simulator**, not direct iPhone installation.
Physical iPhone testing needs Xcode and development signing. There is no app-store release yet.
The pairing steps target development builds; prefer App and Gateway builds from the same revision.

## Connect

1. Install official Tailscale on the computer and phone, sign in to the same
   tailnet, then start the Gateway on the computer:

   ```bash
   qwenaudio gateway --tailnet
   ```

   A server can instead use a trusted HTTPS reverse proxy and declare its public
   address with `qwenaudio gateway --public-url https://voice.example.com`.
2. Generate a connection code in another terminal on the computer:

   ```bash
   qwenaudio gateway pair
   ```

   Scan the QR code or paste the connection code in Mobile. Desktop accepts the
   same connection code.
3. Grant microphone access for the first call. Later launches reconnect
   automatically. If another Client is active, Mobile asks before taking over.

A connection code is short-lived and single-use. Pairing replaces it with an
independent, revocable device credential. Use `qwenaudio gateway devices` to
inspect devices and `qwenaudio gateway revoke <device-id>` to revoke one.
Private Tailnet endpoints are reachable only inside the same tailnet. Operators
own certificates, reverse proxies, and firewalls for External HTTPS. Both modes
use the same pairing and Client protocol.
See
[Remote Access Security](../operations/remote-access.md)
for implementation details, authorization requirements, and troubleshooting.

## Development builds

```bash
npm ci
npm run mobile:sync
npm run mobile:ios
# or
npm run mobile:android
```

iOS requires full Xcode. Android requires JDK 21 and the Android SDK.
`mobile:sync` builds the local web assets before syncing the Capacitor projects.
The Gateway endpoint must use HTTPS; Mobile never downgrades a device credential
to a clear-text WebSocket.

The GitHub `Mobile` workflow retains an Android debug APK and an iOS Simulator
App for testing without a local native toolchain. Installing on a physical iOS
device still requires Apple development signing.
