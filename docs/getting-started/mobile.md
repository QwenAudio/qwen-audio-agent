# Mobile

Mobile is a native presentation of WebUI. The Gateway and Backend Agent keep
running on your computer; the phone owns the microphone, speaker, text/image
input, and UI. It uses the same Gateway Client Protocol as Desktop, WebUI, and
TUI, without importing Realtime Provider or backend-protocol internals.

> iOS and Android development builds are available. App-store distribution is
> not available yet.

## Connect

1. Start the Gateway on the computer, then enable remote access:

   ```bash
   qwenaudio gateway remote enable
   ```

   On first use, the Gateway prepares its optional remote component and prints
   a browser authorization URL. Follow that page once; neither the computer nor
   the phone needs an additional remote-network client installed.
2. After authorization completes, create an invitation:

   ```bash
   qwenaudio gateway remote invite
   ```

3. Open Mobile and scan the QR code shown in Desktop settings. When using the
   CLI, paste the emitted `qwaudio://connect…` link.
4. Grant microphone access for the first call. Later launches reconnect
   automatically. If Desktop, WebUI, or TUI is active, Mobile asks before taking
   over.

An invitation is short-lived and single-use. Pairing creates an independent,
revocable device credential. Run `qwenaudio gateway remote devices` on the host
to inspect devices and `qwenaudio gateway remote revoke <device-id>` to revoke
one.

The public HTTPS/WSS route remains protected by the paired-device credential.
See [Remote Access Security](../configuration/advanced.md#remote-access-security)
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
