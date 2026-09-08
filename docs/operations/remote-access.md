# Remote Connections and Pairing

Mobile, Desktop on another computer, and TUI / WebUI can connect to a Gateway on your computer.
The client owns input and output; the Gateway and Backend Agent stay on the host. Desktop is
not required as a relay.

> These steps follow development on `main`. Check that both builds include remote pairing.

## 1. Choose a Connection Method

By default, the Gateway binds to loopback and trusts only literal loopback Host/Origin. Remote
requests require a Gateway access credential before they can reach HTTP or WebSocket business
APIs. Do not expose the Gateway's loopback port directly to the public Internet.

Remote Clients always connect to an ordinary HTTPS/WSS Gateway endpoint. Network publication and
Gateway pairing/device authorization are independent layers. Two publication modes are supported:

- **Private Tailnet** is intended for personal computers. Install official Tailscale on both the
  Gateway host and remote device, and sign in to the same tailnet. The Gateway invokes the system
  `tailscale serve` command to publish a private HTTPS endpoint.
- **External HTTPS** is intended for a server with a trusted certificate. The operator owns the
  reverse proxy, fixed IP or domain. The Gateway only records its public origin and does not own
  networking, certificates, or proxy configuration.

## 2. Start the Endpoint

After installing and signing in to official Tailscale, run the Gateway in the foreground:

```bash
qwenaudio gateway --tailnet
```

The command waits for `tailscale serve` to print its private HTTPS endpoint and stops that
publication when the Gateway exits. For a persistent user service, run
`qwenaudio gateway install --tailnet`, or put this in `config.env`:

```dotenv
QWEN_AUDIO_GATEWAY_TAILNET=1
```

For External HTTPS, configure the reverse proxy first, then declare its exact public origin:

```bash
qwenaudio gateway --public-url https://voice.example.com
```

Or persist it in `config.env`:

```dotenv
QWEN_AUDIO_GATEWAY_PUBLIC_URL=https://voice.example.com
```

A fixed IP with a publicly trusted IP-address certificate can be used as `https://<fixed-ip>`.
The endpoint must be an HTTPS origin without credentials, path, query, or fragment. The proxy must
accept HTTPS only, forward WebSocket correctly, preserve the public `Host`, and forward traffic to
the local `127.0.0.1:3101`.
Also set `Forwarded` or `X-Forwarded-For`. Forwarded requests do not receive the local authentication
exemption and still require pairing or access credentials; these headers never establish identity.
Do not strip both the public `Host` and all forwarding headers, as the Gateway cannot then distinguish
proxy traffic from genuinely local requests.

Tailnet is marked ready only after `tailscale serve status --json` confirms a private HTTPS root proxy
to the current Gateway. A login or consent URL printed by the CLI does not indicate readiness.
Complete first-time authorization through official Tailscale.

## 3. Pair a Client

After the endpoint is ready, open another terminal on the Gateway host and run:

```bash
qwenaudio gateway pair
```

It prints a short-lived, single-use QR code, connection code, and browser URL. Desktop, Mobile,
and other Clients consume the same connection code without knowing whether Tailscale or an
external proxy published the endpoint. Use `qwenaudio gateway devices` to list paired Clients and
`qwenaudio gateway revoke <device-id>` to revoke one.

Remote access does not bypass Gateway authentication: every remote business request except the
one-time pairing shell requires a paired-device credential.

## Verify the Connection

- Check Gateway connectivity and then voice-frontend status. Pairing does not validate model credentials.
- Allow microphone access on the phone. Tailscale provides network reachability, not Gateway authorization.
- When a second client takes over, the previous client disconnects; the Gateway itself has not exited.
- For an expired or used code, rerun `qwenaudio gateway pair` on the Gateway host.
- If a Tailnet endpoint is unreachable, check that both devices are online in the same tailnet, then check policies and HTTPS publication.

See [Mobile](../getting-started/mobile.md) and [Desktop](../desktop/overview.md#remote-connections)
for client steps, or [Troubleshooting](troubleshooting.md) for other errors.

## Advanced Authentication and Reverse Proxies

For one personal access key:

```dotenv
QWEN_AUDIO_GATEWAY_ACCESS_TOKEN=replace-with-at-least-24-random-characters
```

Generate one with `openssl rand -base64 32`. This token authenticates Gateway
access only; never put it in a URL, GCP message, or public log.

Native clients send it as a Bearer token. Browser clients exchange one authenticated HTTP
request for an `HttpOnly`, `SameSite=Strict` session cookie. To serve the browser UI through a
external HTTPS reverse proxy, keep the Gateway on loopback and allowlist the exact public Origin:

```dotenv
HOST=127.0.0.1
QWEN_AUDIO_AGENT_ALLOWED_ORIGINS=https://voice.example.com
```

For example, a native TUI can connect without putting the credential in its URL:

```bash
QWEN_AUDIO_AGENT_URL=https://voice.example.com \
QWEN_AUDIO_GATEWAY_CLIENT_TOKEN="$ACCESS_TOKEN" \
qwenaudio tui
```

The connection code created by `qwenaudio gateway pair` is exchanged by a remote Client at
`POST /api/access/pair` for a revocable device token. Paired
devices can be listed with `GET /api/access/devices` and revoked with
`DELETE /api/access/devices/:id`; management is loopback-only.

Multiple trusted Origins can be separated by commas. Advanced hosts can map separate access
tokens to separate owner identities:

```dotenv
QWEN_AUDIO_AGENT_ACCESS_KEYS='[{"token":"replace-with-a-long-random-token","owner_id":"user_alice","label":"Alice"}]'
```

Each owner has one active Client lease. A second Client is rejected unless it reconnects with
the same `client.instance_id` or explicitly negotiates `session.takeover`; takeover closes the
previous Client and generation-fences late messages from its socket.

`QWEN_AUDIO_AGENT_AUTH_SECRET` only signs local and remote session identities. It is not a
remote access password and must never be sent to a Client.

`QWEN_AUDIO_AGENT_ACCESS_TOKEN` remains a deprecated alias for both settings. New setups use
the separate host and Client names above so a Client credential is never mistaken for Gateway
server configuration.
