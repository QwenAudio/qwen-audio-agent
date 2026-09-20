# Visual Input

You can send files for backend processing or provide live visual context to a voice model. These use different input paths.

| Input | Use case | Recipient |
| --- | --- | --- |
| Chat image/file attachment | Analyze files, edit images, create deliverables | Backend Agent when needed |
| Live camera frames | Discuss objects or scenes in view | A vision-capable voice frontend |
| X-Omni on-demand capture and observation | Inspect screens/images and watch for changes | The example's visual tools and Omni service |

## WebUI Camera

1. Select [Qwen Omni](../voice-frontends/qwen-omni-realtime.md), [Google Live](../voice-frontends/google-live.md), or [MiniCPM-o](../voice-frontends/minicpm-o.md) with `mode=video`.
2. Start the Gateway, open WebUI, connect, and grant microphone permission.
3. Open the camera preview and grant camera permission. Enable the microphone, then select “Start live vision” before asking about the scene.
4. Turn the camera off when finished.

Controls depend on capabilities negotiated with the Gateway. Enabling a camera does not add vision to an audio-only model. Remote browsers need trusted HTTPS; local use can use `localhost` or `127.0.0.1`.

Preview alone sends no frames. Muting the microphone pauses live vision; unmuting resumes it. Stop live vision to stop transmission, or close the camera to also release the device.

Live input sends rate-limited JPEG frames, not video files. A frame does not create a user message or trigger a reply on its own; ask your question by voice. Frames are not automatically saved as attachments, chat history, or knowledge-library documents.

## Client Limits

- Standard WebUI supports live camera input. Desktop's orb and conversation panel, and TUI, do not currently capture live frames.
- Mobile reuses WebUI; camera availability also depends on OS permissions and WebView support.
- MiniCPM-o video mode supports audiovisual chat, but its current adapter has no tool calls or text input and cannot orchestrate backend work.

## Screen Inspection and Observation

Try these in the separate [X-Omni example](../scenarios/x-omni.md), not in the standard Desktop app:

- Choose a camera, screen, or image.
- Capture on demand: preview locally until a tool requests a sample.
- Stream frames during conversation.
- Explicitly start a short observation, such as “Watch this progress bar and tell me when it finishes.”

Observation makes additional model requests. See the example for stop conditions and compatibility.

## Privacy

Close windows containing passwords, keys, or private messages before capture. Cloud vision services receive the frames you send. With local models, check the deployment and logging settings as well. Disable the visual source when returning to voice-only chat.
