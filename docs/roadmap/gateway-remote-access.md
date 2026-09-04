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
                         └── local, Tailscale, manual, or future relay endpoint
```

## Architectural boundaries

1. **Endpoint publication** makes the local Gateway reachable and returns a
   canonical HTTPS/WSS endpoint. Tailscale is the first publisher; manual
   reverse proxies and a future hosted relay use the same port.
2. **Access authentication** runs before GCP. Literal loopback remains
   zero-configuration; every non-loopback HTTP or WebSocket request requires a
   configured or paired device credential.
3. **GCP Session** carries media, input, Tasks, permissions, Client Events,
   Client Actions, history, replay, and takeover without knowing how the
   endpoint was published.
4. **Client presentation** owns platform I/O and UI. Client type is diagnostic
   metadata; negotiated capabilities, rather than type checks, define behavior.

Tailscale names, commands, identities, and headers must not enter Gateway Core,
GCP envelopes, model context, Task state, or BackendPort. A host-side endpoint
publisher may invoke Tailscale and return an ordinary Gateway endpoint.

## User experience

- Local Clients continue to connect to `http://127.0.0.1:3101` without setup.
- A host management surface enables remote access and creates a short-lived
  invitation. Desktop renders it as a QR code; CLI can print or export it.
- A remote Desktop, TUI, WebUI, or Mobile Client consumes the same invitation,
  exchanges it for a revocable device credential, and stores that credential in
  platform-secure storage.
- Multiple devices may be paired, but each owner has one active interactive
  Client. A second Client asks the user before negotiating `session.takeover`.
- Reconnect by the same `client.instance_id` is automatic. Takeover by another
  Client never causes competing reconnect loops.

Ordinary users must not copy tokens, edit URLs, or run network commands. Manual
endpoint and environment-variable flows remain advanced escape hatches.

## Shared public models

An endpoint descriptor identifies a reachable Gateway without entering GCP:

```json
{
  "url": "https://gateway.example.ts.net",
  "transport": "websocket",
  "secure": true,
  "publisher": "tailscale"
}
```

A Client connection profile stores only a secure-store reference, never the raw
credential:

```json
{
  "id": "phone",
  "gateway_url": "https://gateway.example.ts.net",
  "device_id": "device_example",
  "credential_ref": "platform-secure-store-key",
  "client_instance_id": "mobile_example"
}
```

An invitation contains no permanent token, model credential, memory, or backend
configuration:

```json
{
  "version": 1,
  "gateway_url": "https://gateway.example.ts.net",
  "pairing_code": "short-lived-one-time-code",
  "expires_at": 1780000000000
}
```

Native Clients use an Authorization header. Browsers exchange authentication for
an HttpOnly, SameSite cookie before opening WebSocket.

## RA0 — Freeze the remote-access contract

- [x] Merge this bilingual roadmap and link issue #320.
- [x] Add endpoint, connection-profile, invitation, and publisher contracts.
- [x] Characterize existing loopback, token, pairing, lease, and takeover behavior.
- [x] Record that management requests do not claim the active interactive lease.

Exit criteria: remote access can be implemented without adding Tailscale or
Mobile branches to Gateway Core.

## RA1 — Endpoint publication and connection profiles

- [x] Add a host-side `GatewayEndpointPublisher` contract and registry.
- [x] Implement local and manual endpoint publishers.
- [x] Add a versioned connection-profile store with a credential-store port.
- [x] Keep server access configuration separate from Client credentials.
- [x] Publish shared helpers for invitation creation and consumption.

Exit criteria: any host can publish an endpoint and any native Client can save
and reconnect through a provider-neutral connection profile.

## RA2 — Tailscale publisher

- [x] Implement one shared Tailscale adapter for Desktop and CLI.
- [x] Detect installation, login, readiness, hostname, and publication state
  from machine-readable output.
- [x] Publish a dedicated Gateway endpoint without overwriting unrelated user
  Tailscale Serve configuration, while keeping Gateway on loopback.
- [x] Add CLI status, enable, disable, invite, device-list, and revoke commands.
- [ ] Validate persistent GCP WebSocket behavior before selecting the final Serve
  mode; retain a direct tailnet fallback.

Exit criteria: a user enables Tailscale remote access without editing Gateway
configuration, copying a token, or exposing a LAN/public listener.

## RA3 — First-party remote Client parity

- [x] Add `mobile` to reference Client profiles and remove behavior-driving
  Client-type allowlists from Gateway.
- [x] Add a minimal unauthenticated browser pairing shell while keeping every
  business API and application page protected.
- [x] Let remote WebUI persist an HttpOnly session and reconnect safely.
- [x] Let Desktop and TUI consume invitations and store revocable credentials
  outside ordinary settings (OS-protected storage on Desktop; an owner-only
  file for terminal clients without a portable keychain API).
- [x] Add uniform occupied, takeover-confirmation, replaced, revoked, offline,
  and reconnect states.

Exit criteria: Desktop, WebUI, and TUI pass the same conformance suite locally
and remotely.

## RA4 — Mobile Client

- [x] Add a native iOS foundation for invitation validation, one-time pairing,
  Keychain credential storage, connection profiles, and the GCP 6.0 handshake.
- [ ] Reuse the public Gateway Client SDK semantics and capability profiles; do not import
  Gateway, Realtime, ACP, A2A, or Electron internals.
- [ ] Provide QR/deep-link pairing and secure credential storage.
- [ ] Support realtime microphone capture, audio playback, voice interruption,
  mute, text, image/file input, history, Task cards, permission and backend-input
  responses, reconnect/replay, and explicit takeover.
- [ ] Keep one conversation model across voice and typed input.
- [ ] Produce reproducible iOS and Android development builds and document the
  external Tailscale prerequisite.

Exit criteria: a phone on the same tailnet pairs once, reconnects later, and
completes the same core conversation and Task flows as WebUI.

## RA5 — Hardening and release readiness

- [ ] Add negative tests for unauthenticated remote requests, origin bypass,
  expired/replayed invitations, revoked devices, and stale leases.
- [ ] Test direct and relayed Tailscale paths, Wi-Fi/cellular transitions,
  computer sleep/wake, Gateway restart, and one-hour WebSocket/audio sessions.
- [ ] Run protocol conformance against Desktop, WebUI, TUI, and Mobile.
- [ ] Add macOS, Windows, Linux, iOS, and Android build checks where toolchains
  are available.
- [ ] Update the user manual only after the reference path is reproducible.

Exit criteria: the remote path fails closed, recovers without duplicate input or
playback, and does not regress local zero-configuration use.

## PR policy

- Each implementation PR references issue #320 and names its RA stage.
- Protocol/core changes, Tailscale host integration, and Mobile UI do not land in
  one review unit.
- Every public model ships with Schema, parser, negative tests, and bilingual
  documentation.
- No endpoint publisher may change Gateway Task, Realtime, BackendPort, or GCP
  behavior.
- No Client stores a raw credential in ordinary settings, logs, URLs, QR history,
  or model-visible context.
