# WebUI

The WebUI is the browser conversation client. The Gateway serves it as static
pages on its own origin — no separate frontend service to deploy.

## Opening

With the Gateway running, open the WebUI in another terminal:

```bash
qwenaudio webui
```

This prints the page URL (default `http://127.0.0.1:3101`) and opens it in your
default browser. The browser asks for microphone permission on first use; allow
it to enable voice.

Options:

| Option | Meaning |
| --- | --- |
| `--url URL` | Connect to a Gateway at another address (default `http://127.0.0.1:3101`) |
| `--session ID` | Resume a specific voice session |
| `--takeover` | Take over voice control from the currently active client |
| `--no-open` | Print the URL only, without opening a browser |

## What you can do

- **Full-duplex voice** — speak and interrupt naturally, with live transcripts.
- **Text and images** — type messages or attach images when the selected
  realtime model supports image input.
- **Task view** — follow background tasks dispatched to the backend agent,
  including progress and final results.

## Relationship to other clients

The TUI, WebUI, and the desktop orb all connect to the same Gateway as
Conversation Clients. One Gateway serves **one active voice client at a time**;
hand voice control over with `--takeover`, or simply close the other client.
The same WebUI page also powers the desktop app's conversation window, so
behavior stays consistent across surfaces.

> Exposing the WebUI beyond your own machine crosses a trust boundary: put an
> HTTPS reverse proxy with authentication in front and follow
> [Remote Access Security](../configuration/advanced.md#remote-access-security).
