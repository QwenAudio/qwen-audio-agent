# qwen-audio-agent-webrtc

Optional WebRTC media extension for qwen-audio-agent. WSS users do not need it.

This extension is not yet published. The following commands describe the release workflow:

```sh
npm install -g qwen-audio-agent qwen-audio-agent-webrtc
qwenaudio gateway --webrtc
```

Install both packages using the same npm prefix. Configure a DashScope Audio or
Omni model in the Gateway before starting. Local Node.js integrations can install
both packages together without `-g`.

The extension declares API version 1 and exposes a lazy `loadNative()` factory.
The Gateway checks compatibility before use and loads native libraries only in
isolated media workers. This package does not start a server or enable WebRTC itself.

For source development, run `npm run example:webrtc:install` at the repository root.
The package is versioned and published independently from `packages/webrtc` and
is excluded from the default workspace install and the main npm package.
