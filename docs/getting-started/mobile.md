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
   a browser authorization URL. Follow it once to join the Gateway to your
   private tailnet. The computer does not need a separate Tailscale install.
2. Install and sign in to the official Tailscale app on the phone, joining the
   same tailnet as the Gateway.
3. After authorization completes, create an invitation:

   ```bash
   qwenaudio gateway remote invite
   ```

4. The command prints a QR code, a native-client connection link, and a browser
   access link. Mobile can scan the QR code or paste the connection link;
   Desktop accepts the same connection link in Settings; without a native
   client, open the browser link.
5. Grant microphone access for the first call. Later launches reconnect
   automatically. If Desktop, WebUI, or TUI is active, Mobile asks before taking
   over.

An invitation is short-lived and single-use. The Gateway CLI exclusively owns
remote-access enablement, invitations, and device management; Clients only
consume invitations. Pairing creates an independent,
revocable device credential. Run `qwenaudio gateway remote devices` on the host
to inspect devices and `qwenaudio gateway remote revoke <device-id>` to revoke
one.

By default, the remote HTTPS/WSS endpoint is reachable only inside the private
tailnet and Tailscale prefers a direct device-to-device path. It may use a DERP
relay on restrictive networks. For a temporary public endpoint, explicitly run
`qwenaudio gateway remote invite --mode funnel`. Gateway business APIs remain
protected by paired-device credentials in either mode. See
[Remote Access Security](../configuration/advanced.md#remote-access-security)
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
