# TUI

[Start the Gateway](../operations/gateway.md), then run in another terminal:

```bash
qwenaudio tui
```

For a remote Gateway, [import a connection code](../operations/remote-access.md#_3-connect-a-client) first. TUI does not select or start a Backend Agent.

## Platform Differences

| Platform | Default Mode | Interruption Method |
| --- | --- | --- |
| macOS | Full-duplex with echo cancellation | Speak directly |
| Linux / Windows | Half-duplex | Enter `/interrupt` |

## Common Operations

| Action | Command / key |
| --- | --- |
| Send text | Type and press Enter |
| Mute / unmute microphone | `/mute` (or `/m`) |
| Interrupt in half-duplex | `/interrupt` (or `/x`) |
| Show help | `/help` (or `/h`) |
| Browse history | `PageUp` / `PageDown` |
| Exit TUI | `/exit` or `Ctrl-C` |

Muting does not cancel backend work or disable result playback. Exiting TUI does not stop a separately running Gateway.

## Terminal Layout

The TUI uses a full-screen, two-region layout. The scrollable upper region shows
conversation history, live voice transcripts, task state, and connection logs.
Gateway and microphone state plus a persistent text composer stay fixed at the
bottom. Asynchronous output and reconnect attempts do not interrupt text editing.
Use `PageUp` / `PageDown` to browse history and `Ctrl-C` to exit at any time.

## Text and Attachment Input

In addition to voice, the TUI accepts text, images, and regular files:

- Type directly in the bottom composer and press Enter to send.
- Paste a local file path to immediately show an image as `[Image N]` or a
  regular file as `@absolute-path`, staging it for the next turn.
- An `@file-path` in the text is sent as an attachment.
- Enter `/mute` to mute or restore the microphone, or `/help` for all commands.

A staged attachment can accompany either composer text or the next voice turn.
Deleting its anchor from the composer also removes the staged attachment.

TUI reads and uploads attachments; the Gateway does not need access to your local path. Each attachment is limited to 8 MB, with a 12 MB total per turn. The frontend receives a reference and can pass the original content to the backend. Pasting an image does not give an audio-only model vision. See [Conversation & Attachments](../guides/conversation.md).

## macOS

macOS always uses CoreAudio AEC full-duplex: audio is continuously captured during playback, supporting direct-speech interruption,
without additional configuration. The CoreAudio helper program is compiled by default to
`~/Library/Caches/qwaudio/tui/macos-voice-io` and is automatically built on first launch. If the Swift compiler is missing, install Xcode Command Line Tools with `xcode-select --install`.

## Linux / Windows

By default, half-duplex mode is used via the bundled Python audio bridge using `sounddevice` / PortAudio:
the microphone is paused during reply playback. Enter `/interrupt` to stop playback manually; capture resumes after playback ends or is interrupted.
Prepare Python, `sounddevice`, and an available PortAudio library. Install `sounddevice` in the Python environment TUI actually uses:

```bash
python -m pip install sounddevice
```

Linux uses `python3` by default; Windows uses `python`. Set `PYTHON` to an absolute interpreter path to override it. If Linux reports a missing PortAudio library, install the appropriate runtime package through your system package manager.

You can also enable full-duplex mode without echo cancellation:

```bash
qwenaudio tui --audio-mode full
```

This mode has no echo cancellation; please wear headphones to avoid misrecognition or false interruptions caused by speaker audio.
Different sound cards and Bluetooth headsets have varying levels of support for simultaneous input and output streams at different sample rates; if you continuously
experience input overflow, output underflow, or device errors, please exit and fall back to `--audio-mode half`.

## Configuration

The default audio mode can also be set persistently via an environment variable:

```dotenv
QWEN_AUDIO_AGENT_TUI_AUDIO_MODE=half
```

Setting it to `full` is equivalent to `--audio-mode full`. For full parameter details, see
[Configuration](../configuration.md).
