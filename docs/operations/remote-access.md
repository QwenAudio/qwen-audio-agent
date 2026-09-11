# Remote Connections and Pairing

Mobile, Desktop on another computer, and TUI / WebUI can connect to a Gateway on your computer.
The client owns input and output; the Gateway and Backend Agent stay on the host. Desktop is
not required as a relay.

> These steps follow development on `main`. Check that both builds include remote pairing.

## 1. Choose a Connection Method

By default, the Gateway binds to loopback and trusts only literal loopback Host/Origin. Remote
requests require a Gateway access credential before they can reach HTTP or WebSocket business
APIs. Do not expose the Gateway's loopback port directly to the public Internet.

Clients always use the WebSocket endpoint and device token stored in their connection code. Network publication and
Gateway pairing/device authorization are independent layers. The Gateway has only three run modes:
local, LAN, and Tailnet.

- **LAN** is intended for hardware and native Clients on the same trusted Wi-Fi. The Gateway
  explicitly binds to the LAN, prefers a physical-interface IPv4 address, and advertises a direct `ws://`
  endpoint. Never forward this endpoint to the public Internet.
- **Private Tailnet** is intended for personal computers. Install official Tailscale on both the
  Gateway host and remote device, and sign in to the same tailnet. The Gateway invokes the system
  `tailscale serve` command to publish a private HTTPS endpoint.

## 2. Start the Endpoint

For direct access on the same LAN:

```bash
qwenaudio gateway --lan
```

This binds the Gateway to `0.0.0.0`, while the connection code contains the selected physical-interface IPv4
rather than the unusable wildcard address. Use `qwenaudio gateway install --lan` for a persistent
service, or set `QWEN_AUDIO_GATEWAY_LAN=1`. On a host with multiple physical interfaces, set
`QWEN_AUDIO_GATEWAY_LAN_HOST=192.168.x.x` to select one explicitly.

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

A reverse proxy is not a Gateway run mode. Keep the default local mode when the proxy runs on the
same host; use `--lan` when the proxy runs on another machine. After configuring the proxy, override
the public endpoint only when generating the connection code:

```bash
qwenaudio gateway pair --endpoint https://voice.example.com --name "AI Passport"
```

A fixed IP with a publicly trusted IP-address certificate can be used as `https://<fixed-ip>`.
The endpoint must be an HTTPS origin without credentials, path, query, or fragment. The proxy must
accept HTTPS only, forward WebSocket correctly, preserve the public `Host`, and forward traffic to
`127.0.0.1:3101` on the same host or the Gateway's LAN address.
Also set `Forwarded` or `X-Forwarded-For`. Forwarded requests do not receive the local authentication
exemption and still require pairing or access credentials; these headers never establish identity.
Do not strip both the public `Host` and all forwarding headers, as the Gateway cannot then distinguish
proxy traffic from genuinely local requests.

Tailnet is marked ready only after `tailscale serve status --json` confirms a private HTTPS root proxy
to the current Gateway. A login or consent URL printed by the CLI does not indicate readiness.
Complete first-time authorization through official Tailscale.

## 3. Connect a Client

After the endpoint is ready, open another terminal on the Gateway host and run:

```bash
qwenaudio gateway pair --name "AI Passport"
```

The Gateway host directly issues an independent, revocable device token. The small QR contains a
URL such as `https://gateway/c#credential` (or `http://IP/c#credential` on LAN) and uses it as the
only connection code. Scanning it opens the Gateway WebUI even without an installed Client;
installed Clients can scan or paste the same code. The Gateway no longer generates or returns a long
`qwaudio://connect#...` deep link. The credential is shown once.

Desktop, Mobile, and other native Clients save the credential, then use one WebSocket connection for
authentication, session negotiation, voice, Tasks, history, and approvals—there is no HTTPS pairing
exchange. The browser shell exchanges the device token in the fragment for an HttpOnly cookie; the
fragment is never included in an HTTP request or access log. The flow is identical for LAN, Tailnet,
and a `pair --endpoint` override. Use `qwenaudio gateway devices` to list Clients and
`qwenaudio gateway revoke <device-id>` to revoke one.
During a rolling upgrade, only older Clients need `qwenaudio gateway pair --legacy` to generate
a short-lived, single-use pairing code.

In Desktop, paste the complete connection code into Settings → Application → Gateway and click
Apply to save and connect. The same field accepts local or previously saved remote Gateway URLs;
there is no separate remote-connection setting.

LAN and remote access do not bypass Gateway authentication: the WebSocket handshake must carry the device credential.

## Verify the Connection

- Check Gateway connectivity and then voice-frontend status. Importing a code does not validate model credentials.
- Allow microphone access on the phone. Tailscale provides network reachability, not Gateway authorization.
- When a second client takes over, the previous client disconnects; the Gateway itself has not exited.
- If a code leaks or a device changes, revoke the old device and rerun `qwenaudio gateway pair` on the Gateway host.
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

Native clients send it as a Bearer token in the WSS handshake. Browser clients carry the same token
through the WebSocket subprotocol. To serve the browser UI through a
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

`qwenaudio gateway pair` uses the loopback-only `POST /api/access/devices` management endpoint to
issue a direct device connection code. Devices can be listed with `GET /api/access/devices` and
revoked with `DELETE /api/access/devices/:id`; revocation immediately closes active WSS connections.
The short-lived pairing endpoints remain for compatibility, but new Clients do not depend on them.

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
