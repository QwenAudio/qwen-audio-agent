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
No physical microphone or cloud API key is needed.
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
