# WebUI browser smoke

Install dependencies with `npm ci`, install Chromium with
`npx playwright install chromium`, then run `npm run test:web-browser`.
The script builds the WebUI and starts Vite preview on loopback port 4174. Set
`QWEN_BROWSER_SMOKE_PORT` if that port is occupied.

Chromium loads the production React bundle. Gateway is a test double; lifecycle
scenarios also use controlled microphone and AudioContext doubles, with native
MessageChannels for worklet messages. A separate scenario uses Chromium's fake
microphone and native Web Audio/AudioWorklet to verify production module loading,
non-silent PCM delivery, socket backpressure/recovery, and microphone mute.
The native-audio scenario also runs through the real desktop renderer server,
including its token-prefixed asset paths and unchanged `script-src 'self'` CSP.
This catches worklet assets accidentally inlined as blocked `data:` URLs.
No physical microphone or cloud API key is needed.
Video-call scenarios use Chromium's fake camera and microphone with native
capture: separate video/microphone controls, video before microphone permission,
camera off/on without muting voice, microphone mute without stopping video,
responsive preview placement, reconnect, permission denial/retry, and a late
permission grant after the panel closes. Audio-only transports retain the
microphone entry; camera capture never starts merely from loading the page.
Visual state uses `client.event.publish` independently of image buffers. Tests
check state edges, no per-frame duplicates, camera disconnects, and republishing
inactive state after an upstream reconnect with the preview already closed.
The Gateway double uses the shared protocol version and checks that the client
requests that version during the handshake.

The reconnect scenario closes the established connection during playback,
requires a new connection's negotiated heartbeat response, then sends another
PCM frame and checks its connection ID and visible reply. It also delivers a
late reply through the closed socket to verify the SDK ignores it. Microphone
acquisition counts must remain unchanged during reconnect.

Unexpected page exceptions and console errors fail the run before the page is
closed. On failure, each run saves screenshots, `trace.zip`, `errors.log`, and
`vite.log` in a timestamped directory under
`output/playwright/browser-webui-smoke/`. Open the trace with
`npx playwright show-trace <path-to-trace.zip>`. The Ubuntu baseline CI uploads
that directory as `browser-voice-diagnostics` and retains it for seven days.
Successful runs produce no new saved diagnostics; prior failure directories
remain available locally and are ignored by Git.

To verify the diagnostic failure path, run with
`QWEN_BROWSER_SMOKE_INJECT_ERROR=1`. This deliberately injects a page exception;
the command must exit nonzero and save the diagnostic artifacts. Unset the
variable for normal validation.
