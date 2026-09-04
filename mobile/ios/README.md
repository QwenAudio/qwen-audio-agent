# iOS Gateway client foundation

This Swift package is the first native iOS slice of
[RA4 — Mobile Client](../../docs/roadmap/gateway-remote-access.md#ra4--mobile-client).
It implements the security-sensitive boundary needed before microphone and UI
work can safely connect to a personal qwen-audio-agent Gateway:

- decode the versioned `qwaudio://connect#...` invitation without sending its
  fragment to a server;
- reject expired, contaminated, or remotely insecure Gateway origins;
- redeem the short-lived one-time pairing code at `/api/access/pair`;
- store only a credential reference in the connection profile and keep the
  revocable device token in the iOS Keychain with
  `AfterFirstUnlockThisDeviceOnly` accessibility;
- open the authenticated `/api/realtime` WebSocket and negotiate GCP 6.0 with a
  `mobile` `session.hello`.

The package deliberately contains no Realtime-provider API key, Backend Agent
configuration, public relay, or vendor-specific device protocol. A phone must
reach an HTTPS Gateway endpoint through the documented Tailscale path (or an
equivalently authenticated private deployment). Never expose the loopback
Gateway directly to the public Internet.

## Integrate

Add `mobile/ios` as a local Swift package in Xcode, then handle the deep link:

```swift
let invitation = try GatewayInvitationCodec.decode(url)
let credentials = KeychainGatewayCredentialStore()
let profiles = UserDefaultsGatewayProfileStore()
let outcome = try await GatewayPairingClient().pair(
    invitation: invitation,
    device: GatewayDevice(id: deviceID, label: UIDevice.current.name),
    clientInstanceID: clientInstanceID,
    credentialStore: credentials,
    profileStore: profiles
)
```

Connect later without displaying or copying the token:

```swift
let client = GatewaySessionClient()
let ready = try await client.connect(
    profile: outcome.profile,
    credentialStore: credentials,
    configuration: GatewaySessionConfiguration(clientInstanceID: clientInstanceID)
)
```

The host creates the invitation locally:

```bash
qwenaudio gateway remote enable
qwenaudio gateway remote invite
```

Install and sign in to Tailscale on both the Gateway host and iPhone before
pairing. The invitation is short-lived and one-time. If a phone is lost, revoke
it from the host with `qwenaudio gateway remote revoke DEVICE_ID`.

## Verify

```bash
cd mobile/ios
swift test
```

The package targets iOS 17 or later. macOS 13 is enabled only so the pure codec,
pairing, persistence, and handshake models can run in local and CI tests.

## Scope still to add

RA4 still needs the user-facing iOS application: QR scanning, microphone
capture, audio playback and interruption, text and file input, Task and
permission surfaces, replay recovery, explicit takeover UI, and reproducible
signed development builds. Those changes should remain separate review units.
