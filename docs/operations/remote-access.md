# Remote Connections

Remote clients handle input and output; the Gateway and Backend Agent run on the computer or server. Desktop is not a relay. First make the address reachable, then create a connection code—network access and device authorization are separate.

## 1. Choose a Connection Method

| Scenario | Network setup | Gateway command |
| --- | --- | --- |
| Same trusted LAN | Allow devices to reach the computer's port; suitable for native clients | `qwenaudio gateway --lan` |
| Personal computer across networks | Install official Tailscale on both ends and join the same Tailnet | `qwenaudio gateway --tailnet` |
| Your HTTPS server | Trusted certificate and a WebSocket-capable reverse proxy | Start a regular Gateway and proxy requests to it |

Remote browsers require trusted HTTPS for microphone access. A plain LAN HTTP address does not guarantee WebUI microphone access; the native mobile client supports explicit LAN connections. Keep the Gateway host powered on and awake.

### LAN

```bash
qwenaudio gateway --lan
```

The Gateway listens on `0.0.0.0`; the connection code uses an automatically selected physical IPv4 address. If the wrong interface is selected, set this in `config.env`:

```dotenv
QWEN_AUDIO_GATEWAY_LAN_HOST=192.168.1.20
```

Use your actual local address. Do not forward this HTTP endpoint to the public internet.

### Tailnet

Sign in to the same Tailnet on the computer and remote device, then run:

```bash
qwenaudio gateway --tailnet
```

The Gateway uses system `tailscale serve` to publish a private HTTPS address and stops that publication when it exits. Complete first-time HTTPS authorization in Tailscale; a login link alone does not mean the endpoint is ready.

For a background service, use `qwenaudio gateway install --tailnet` or `qwenaudio gateway install --lan`. Do not enable both modes. Tailscale is not embedded in the app; the phone also needs the official Tailscale app.

### Your Own HTTPS Endpoint

With the proxy on the Gateway host, run `qwenaudio gateway` and forward to `127.0.0.1:3101`. For a proxy on another machine, use `--lan` and restrict access with a firewall.

- The proxy must support WebSocket and preserve the public `Host`.
- Preserve `Forwarded` or `X-Forwarded-For` as well. Removing both the public `Host` and all forwarding headers prevents the Gateway from distinguishing proxy requests from local requests.
- Configure the allowed browser origin: `QWEN_AUDIO_AGENT_ALLOWED_ORIGINS=https://voice.example.com`.
- A fixed IP also works if its HTTPS certificate is trusted by the client and covers that IP.

## 2. Generate a Connection Code

In another terminal **on the Gateway host**, run:

```bash
qwenaudio gateway pair --name "My phone"
```

LAN / Tailnet addresses are selected automatically. For your own HTTPS endpoint, specify it:

```bash
qwenaudio gateway pair --endpoint https://voice.example.com --name "My phone"
```

The endpoint contains only a scheme, host, and optional port—no path or query.

The command prints a QR code and the same connection link, shaped like `https://host/c#credential` (LAN: `http://IP:port/c#credential`). It contains a device credential shown only once. **Generate one per device; do not share it publicly or include it in logs.**

## 3. Connect a Client

| Client | Action |
| --- | --- |
| Mobile app | Scan or paste the full code, then allow microphone access. |
| Desktop | Paste the full code in “Settings → Application → Gateway” and select Apply. |
| WebUI | Open the full link in a browser; it saves authentication for the page. |
| TUI | Run `connect` below, then start TUI. |

```bash
qwenaudio connect 'paste-the-full-connection-code'
qwenaudio tui
```

Keep the quotes because the link contains special characters. `connect` saves TUI configuration, not Gateway settings; use `qwenaudio disconnect` to clear it. Desktop and Mobile save their own credentials for future connections.

Each user has one active client per Gateway. Taking over disconnects the previous client, not the Gateway.

## Manage Devices

```bash
qwenaudio gateway devices
qwenaudio gateway revoke <deviceID>
```

Revocation closes active connections using that credential. Revoke and pair again after a code leak, device loss, or replacement.

## Verify the Connection

- Check Gateway connectivity before voice frontend and backend status. Pairing does not validate model credentials.
- Tailnet unreachable: check both devices are online, in the same Tailnet, and allowed by access policy; check Serve status.
- LAN unreachable: check the interface address, firewall, and `--lan` startup.
- HTTPS page opens but chat fails: check WebSocket forwarding, allowed Origin, and credentials.
- No audio or microphone input: check client permissions, volume, and secure context in [Troubleshooting](troubleshooting.md).

## Advanced Authentication and Reverse Proxies

Custom clients can use a separate access key instead of importing a connection code:

```dotenv
# config.env on the Gateway host
QWEN_AUDIO_GATEWAY_ACCESS_TOKEN=replace-with-at-least-24-random-characters
```

Generate a key with `openssl rand -base64 32`. TUI uses a separate variable:

```bash
QWEN_AUDIO_AGENT_URL=https://voice.example.com \
QWEN_AUDIO_GATEWAY_CLIENT_TOKEN="$ACCESS_TOKEN" \
qwenaudio tui
```

Native clients use a handshake Bearer Token; browsers use a supported WebSocket subprotocol. Do not put this key in ordinary URLs, protocol messages, or public logs. `QWEN_AUDIO_AGENT_AUTH_SECRET` signs internal identities; it is not a client access key.

See the [Gateway contract](../contract.md) and [Client Protocol](../gateway-protocol.md) for APIs, identity mapping, and takeover rules. For everyday use, prefer individually revocable device codes.
