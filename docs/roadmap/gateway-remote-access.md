# Gateway Remote Access and Mobile Client Roadmap

> Status: in progress
>
> Tracking: [GitHub issue #320](https://github.com/QwenAudio/qwen-audio-agent/issues/320)
>
> Protocol: [Gateway Client Protocol](../gateway-protocol.md)

## Goal

Let a Client connect to the same personal Gateway from the Gateway host, another
computer, or a mobile device. Desktop, WebUI, TUI, and Mobile remain
interchangeable Client Environments. They use the same GCP and never depend on a
Realtime Provider or Backend Agent implementation.

Remote access is a deployment topology, not a Client type or a new application
protocol:

```text
Desktop ─┐
WebUI ───┤
TUI ─────┼── GCP over WebSocket ── Gateway ── BackendPort
Mobile ──┘               ▲
                         └── local endpoint or external HTTPS endpoint
```

## Architectural boundaries

1. **Public endpoints** are owned by the Gateway. Tailnet mode invokes the
   user-installed and authenticated system `tailscale serve`; External HTTPS
   only records an operator-managed public origin. The project neither embeds
   nor downloads the Tailscale network stack.
2. **Access authentication** runs before GCP. Literal loopback remains
   zero-configuration; every non-loopback HTTP or WebSocket request requires a
   configured or paired device credential.
3. **GCP Session** carries media, input, Tasks, permissions, Client Events,
   Client Actions, history, replay, and takeover without knowing how the
   endpoint was published.
4. **Client presentation** owns platform I/O and UI. Client type is diagnostic
   metadata; negotiated capabilities, rather than type checks, define behavior.

Tailscale names, identities, and internal events stay inside the remote-access
module and never enter GCP envelopes, model context, Task state, or BackendPort.
Clients see only an ordinary Gateway endpoint.

## User experience

- Local Clients continue to connect to `http://127.0.0.1:3101` without setup.
- The Gateway CLI declares a public endpoint through `gateway --tailnet` or
  `gateway --public-url`; `gateway pair` emits the QR code, connection code, and
  browser access link. In Tailnet mode, the Gateway host and remote devices all
  use official Tailscale and join the same tailnet.
- A remote Desktop, TUI, WebUI, or Mobile Client consumes the same pairing code,
  exchanges it for a revocable device credential, and stores that credential in
  platform-secure storage.
- Multiple devices may be paired, but each owner has one active interactive
  Client. A second Client asks the user before negotiating `session.takeover`.
- Reconnect by the same `client.instance_id` is automatic. Takeover by another
  Client never causes competing reconnect loops.

Clients do not understand Tailscale or reverse-proxy details and never require a
long-lived token to be copied. Network installation and authentication stay in
the network layer; the Gateway consumes only the final endpoint.

## Shared public models

An endpoint descriptor identifies a reachable Gateway without entering GCP:

```json
{
  "version": 1,
  "url": "https://gateway.example.ts.net",
  "transport": "websocket",
  "secure": true
}
```

A Client connection profile stores only a secure-store reference, never the raw
credential:

```json
{
  "version": 1,
  "id": "phone",
  "gateway_url": "https://gateway.example.ts.net",
  "device_id": "device_example",
  "credential_ref": "platform-secure-store-key",
  "client_instance_id": "mobile_example"
}
```

A pairing code contains no permanent token, model credential, memory, or backend
configuration:

```json
{
  "version": 1,
  "gateway_url": "https://gateway.example.ts.net",
  "pairing_code": "short-lived-one-time-code",
  "expires_at": 1780000000000
}
```

Native Clients use an Authorization header, and remote WebUI uses an HttpOnly,
SameSite cookie. A local mobile WebView cannot add a header to a WebSocket
upgrade, so it carries its revocable device credential in a second WebSocket
subprotocol value inside TLS. The server selects and echoes only the public GCP
subprotocol. Credentials never enter URLs, GCP messages, logs, or model context.

## RA0 — Freeze the remote-access contract

- [x] Merge this bilingual roadmap and link issue #320.
- [x] Add endpoint, connection-profile, and pairing-code contracts.
- [x] Characterize existing loopback, token, pairing, lease, and takeover behavior.
- [x] Record that management requests do not claim the active interactive lease.

Exit criteria: Tailscale implementation details do not enter GCP, Realtime,
Task, BackendPort, or Client code.

## RA1 — Endpoints and connection profiles

- [x] Add a versioned connection-profile store with a credential-store port.
- [x] Keep server access configuration separate from Client credentials.
- [x] Publish shared helpers for pairing-code creation and consumption.

Exit criteria: any native Client can save and reconnect through one connection
profile contract.

## RA2 — Gateway public endpoints

- [x] Publish a private-tailnet HTTPS/WSS endpoint through the system
  `tailscale serve` command while keeping the Gateway listener on loopback.
- [x] Allow an operator-managed External HTTPS origin without owning its proxy,
  certificate, or network lifecycle.
- [x] Add flat `gateway pair`, `devices`, and `revoke` commands and remove the
  extra remote command layer.
- [x] Keep network publication independent from Gateway pairing/device access.
- [ ] Validate persistent GCP WebSocket and long-running audio on a physical phone.

Exit criteria: a user neither copies a long-lived token nor exposes the Gateway
listener. Tailnet users install official Tailscale on both the Gateway host and
remote device; External HTTPS users own the trusted proxy.

## RA3 — First-party remote Client parity

- [x] Add `mobile` to reference Client profiles and remove behavior-driving
  Client-type allowlists from Gateway.
- [x] Add a minimal unauthenticated browser pairing shell while keeping every
  business API and application page protected.
- [x] Let remote WebUI persist an HttpOnly session and reconnect safely.
- [x] Let Desktop and TUI consume pairing codes and store revocable credentials
  outside ordinary settings (OS-protected storage on Desktop; an owner-only
  file for terminal clients without a portable keychain API).
- [x] Add uniform occupied, takeover-confirmation, replaced, revoked, offline,
  and reconnect states.

Exit criteria: Desktop, WebUI, and TUI pass the same conformance suite locally
and remotely.

## RA4 — Mobile Client

- [x] Reuse the public Gateway Client SDK and capability profiles; do not import
  Gateway, Realtime, ACP, A2A, or Electron internals.
- [x] Provide QR/deep-link pairing and secure credential storage.
- [x] Support realtime microphone capture, audio playback, voice interruption,
  mute, text, image/file input, history, Task cards, permission and backend-input
  responses, reconnect/replay, and explicit takeover.
- [x] Keep one conversation model across voice and typed input.
- [x] Produce reproducible iOS and Android development builds.

Exit criteria: a phone pairs through the private-tailnet HTTPS endpoint, reconnects
later, and completes the same core conversation and Task flows as WebUI.

## RA5 — Hardening and release readiness

- [x] Add negative tests for unauthenticated remote requests, origin bypass,
  expired/replayed pairing codes, revoked devices, and stale leases.
- [x] Reuse the paired, persisted Client instance identity after a Mobile app
  restart so it is not mistaken for a different client.
- [ ] Test direct-tailnet/DERP fallback, Wi-Fi/cellular transitions,
  computer sleep/wake, Gateway restart, and one-hour WebSocket/audio sessions.
- [x] Run protocol conformance against Desktop, WebUI, TUI, and Mobile.
- [x] Add macOS, Windows, Linux, iOS, and Android build checks; real-device
  scenarios remain covered by the item above.
- [x] Update the bilingual user manual and development-build guide after the
  reference path is reproducible.

Exit criteria: the remote path fails closed, recovers without duplicate input or
playback, and does not regress local zero-configuration use.

## PR policy

- Each implementation PR references issue #320 and names its RA stage.
- Protocol/core changes, public-endpoint network adapters, and Mobile UI should remain
  separately reviewable.
- Every public model ships with Schema, parser, negative tests, and bilingual
  documentation.
- The remote-access module must not change Gateway Task, Realtime, BackendPort, or GCP
  behavior.
- No Client stores a raw credential in ordinary settings, logs, URLs, QR history,
  or model-visible context.
