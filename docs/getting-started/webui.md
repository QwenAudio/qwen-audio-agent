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

The interface follows your browser's preferred language (Chinese or English).
To override it for a page, add `?lang=zh` or `?lang=en` to the URL.

Options:

| Option | Meaning |
| --- | --- |
| `--url URL` | Connect to a Gateway at another address (default `http://127.0.0.1:3101`) |
| `--session ID` | Resume a specific voice session |
| `--no-open` | Print the URL only, without opening a browser |

## What you can do

- **Full-duplex voice** — speak and interrupt naturally, with live transcripts.
- **Text and attachments** — type messages or add images and files. Ordinary attachments can be handled by the backend; the voice model need not understand images directly.
- **Task view** — follow background tasks dispatched to the backend agent,
  including progress and final results.

With video input support, the header adds an “Enable video” button to open the camera preview. The existing microphone button remains independent; disabling video does not affect voice. See [Visual Input](../guides/vision.md) for details and [Conversation & Attachments](../guides/conversation.md) for ordinary file handling.
The top “Knowledge Library” button [imports host documents](../guides/knowledge.md), not chat attachments.

## Relationship to other clients

The TUI, WebUI, and desktop orb all use the same Gateway Client Protocol. A
Gateway accepts **one active Client connection per user**; another client can take over after confirmation, disconnecting the previous one. The desktop app can also run its own
Gateway process while sharing user configuration with the CLI. The same WebUI
page powers the desktop conversation window, so presentation behavior stays
consistent across surfaces.

## Remote Browser Access

Open the full link from [Remote Connections](../operations/remote-access.md) through Tailnet or your HTTPS endpoint. Remote microphone access requires trusted HTTPS. Do not expose the local port directly or disable browser security to work around microphone failures.
