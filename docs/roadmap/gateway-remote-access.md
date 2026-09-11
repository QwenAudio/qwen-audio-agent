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
                         └── local, LAN, Tailnet, or connection-code endpoint
```

## Architectural boundaries

1. **Network modes** are owned by the Gateway. Local binds to loopback, LAN
   explicitly binds to `0.0.0.0`, and Tailnet invokes the user-installed and
   authenticated system `tailscale serve`. An external reverse proxy is deployed
   independently and only overrides the endpoint when issuing a connection code.
   The project neither embeds nor downloads the Tailscale network stack.
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
- The Gateway CLI has only local, `gateway --lan`, and `gateway --tailnet` run modes.
  `gateway pair` directly issues a revocable device credential and emits one QR/connection
  code; use `gateway pair --endpoint` to override it with an external proxy address. In
  Tailnet mode, the Gateway host and remote devices all use official Tailscale and join the
  same tailnet.
- A remote Desktop, TUI, WebUI, or Mobile Client consumes the same direct connection code
  and stores its per-device credential in platform-secure storage without an HTTP exchange.
- Multiple devices may be paired, but each owner has one active interactive
  Client. A second Client asks the user before negotiating `session.takeover`.
- Reconnect by the same `client.instance_id` is automatic. Takeover by another
  Client never causes competing reconnect loops.

Clients do not understand Tailscale or reverse-proxy details and never require a
shared host-wide token. Network installation and authentication stay in
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

A direct connection code is a one-time-display transport envelope. After decoding it contains:

```json
{
  "schema": "qwaudio.connection/v2",
  "websocket_url": "wss://gateway.example.ts.net/api/realtime",
  "device_id": "device_example",
  "credential_id": "device_key_example",
  "access_token": "per-device-secret",
  "issued_at": 1780000000000
}
```

Native Clients use an Authorization header. A local mobile WebView cannot add a header to a WebSocket
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
- [x] Allow an operator-managed external HTTPS origin through `gateway pair --endpoint`
  without modeling the reverse proxy as a Gateway run mode.
- [x] Add flat `gateway pair`, `devices`, and `revoke` commands and remove the
  extra remote command layer.
- [x] Keep network publication independent from Gateway pairing/device access.
- [ ] Validate persistent GCP WebSocket and long-running audio on a physical phone.

Exit criteria: a user never copies a long-lived shared token. LAN users explicitly
control the listener scope, Tailnet users install official Tailscale on both the
Gateway host and remote device, and external HTTPS users own the trusted proxy.

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
