# TUI Usage Notes

## Platform Differences

| Platform | Default Mode | Interruption Method |
| --- | --- | --- |
| macOS | Full-duplex with echo cancellation | Speak directly |
| Linux / Windows | Half-duplex | Press `x` during playback |

## macOS

macOS always uses CoreAudio AEC full-duplex: audio is continuously captured during playback, supporting direct-speech interruption,
without additional configuration. The CoreAudio helper program is compiled by default to
`~/Library/Caches/qwaudio/tui/macos-voice-io` and is automatically built on first launch.

## Linux / Windows

By default, half-duplex mode is used via the bundled Python audio bridge using `sounddevice` / PortAudio:
the microphone is paused during reply playback, only supporting manual interruption with the `x` key, and resumes after playback ends or is interrupted.
Before first use, install `sounddevice` and the system PortAudio.

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
